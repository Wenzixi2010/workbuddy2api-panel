package panel

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/panelauth"
)

// sessionTTLOf 从配置解析会话有效期（New 里构造管理器时用，此时 Panel 还没成形）。
func sessionTTLOf(cfg Config) time.Duration {
	if cfg.PanelSessionTTL != nil {
		if d := cfg.PanelSessionTTL(); d > 0 {
			return d
		}
	}
	return panelauth.DefaultTTL
}

// sessionTTL 面板会话有效期（运行期读取，配置改了以最新为准）。
func (p *Panel) sessionTTL() time.Duration { return sessionTTLOf(p.cfg) }

// credentials 当前生效的面板登录凭据。
//
// PanelAuth 为 nil 时（测试/裸用路径）**没有**账号密码可校验：此时既不能退回
// 「只认 api_key」，也不能放行——见 withAuth 的处理。
func (p *Panel) credentials() panelauth.Credentials {
	if p.cfg.PanelAuth == nil {
		return panelauth.Credentials{}
	}
	u, pw := p.cfg.PanelAuth()
	return panelauth.Credentials{Username: u, Password: pw}
}

// authRequired 面板是否需要登录。
//
// 只要配置了账号密码就必须登录。注意这里**不**再看 api_key：面板与网关鉴权
// 已经分家，继续把 api_key 当面板钥匙会让「改面板密码」这件事失去意义。
func (p *Panel) authRequired() bool { return p.credentials().Configured() }

// sessionToken 从请求里取会话令牌（Cookie 优先）。
//
// 不读 Authorization 头：那是网关的 api_key 通道，面板不该再从这条路进来。
func sessionToken(r *http.Request) string {
	c, err := r.Cookie(panelauth.CookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// currentSession 返回当前请求的会话（未登录返回 false）。
func (p *Panel) currentSession(r *http.Request) (panelauth.Session, bool) {
	return p.auth.Lookup(sessionToken(r))
}

// withAuth 面板 API 鉴权：校验会话 Cookie。
//
// 未配置账号密码时一律 401 并给出明确原因，而不是放行：
// 把「忘了配」当成「开放访问」是这个改动最容易犯也最致命的错误——
// 面板能改配置、能停用账号、能签发 Key。
func (p *Panel) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !p.authRequired() {
			writeErr(w, http.StatusUnauthorized, "panel_auth_not_configured")
			return
		}
		if _, ok := p.currentSession(r); !ok {
			writeErr(w, http.StatusUnauthorized, "login_required")
			return
		}
		next(w, r)
	}
}

// cookieSecure 是否给会话 Cookie 加 Secure。
//
// 判断依据是本次请求自身是否走 TLS，而不是配置项：面板常被放在反代后面，
// 真正的协议只有请求能说明。用 X-Forwarded-Proto 兜住反代场景（反代通常已经
// 终止了 TLS，到本进程是明文 HTTP，但对外是 https）。
func cookieSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")))
	return proto == "https"
}

// setSessionCookie 下发会话 Cookie。
//
// HttpOnly：JS 读不到，XSS 偷不走会话。
// SameSite=Strict：跨站请求根本不带它，CSRF 的基本面由此关闭。
// Path=/panel：只发给面板，不随 /v1 请求外发（少一处泄露面）。
func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     panelauth.CookieName,
		Value:    token,
		Path:     panelauth.CookiePath,
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   cookieSecure(r),
		SameSite: http.SameSiteStrictMode,
	})
}

// clearSessionCookie 清除会话 Cookie（登出）。
func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     panelauth.CookieName,
		Value:    "",
		Path:     panelauth.CookiePath,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   cookieSecure(r),
		SameSite: http.SameSiteStrictMode,
	})
}

// loginReq 登录请求体。
type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// login 面板登录。成功时下发会话 Cookie，响应体不含任何令牌（令牌只在 Cookie 里）。
func (p *Panel) login(w http.ResponseWriter, r *http.Request) {
	// 登录接口本身不加 CSRF 之外的防护，但限制请求体大小：避免被喂超长 JSON。
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var in loginReq
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_json")
		return
	}

	creds := p.credentials()
	token, sess, err := p.auth.Login(creds, strings.TrimSpace(in.Username), in.Password)
	if err != nil {
		switch {
		case errors.Is(err, panelauth.ErrNotConfigured):
			// 配置问题，不是用户的错：给出可操作的提示。
			writeErr(w, http.StatusServiceUnavailable, "panel_auth_not_configured")
		case errors.Is(err, panelauth.ErrThrottled):
			writeErr(w, http.StatusTooManyRequests, "too_many_attempts")
		default:
			// 不区分「账号不存在」与「密码错」，避免用户名枚举。
			writeErr(w, http.StatusUnauthorized, "bad_credentials")
		}
		return
	}

	ttl := p.sessionTTL()
	setSessionCookie(w, r, token, ttl)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"user": sess.User,
		// 过期时刻给前端做「还剩多久」提示；不含令牌本身。
		"expires_at": sess.Expires.Format(time.RFC3339),
	})
}

// logout 面板登出：作废会话并清 Cookie（幂等）。
func (p *Panel) logout(w http.ResponseWriter, r *http.Request) {
	p.auth.Logout(sessionToken(r))
	clearSessionCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// sessionInfo 当前登录态。
//
// 这个接口**不**经过 withAuth：前端启动时先问一次「我登录了吗」，
// 未登录时要拿到 200 + logged_in:false 才好决定渲染登录页还是主界面
// （让前端去分辨 401 是「没登录」还是「登录过期」是没必要的复杂度）。
func (p *Panel) sessionInfo(w http.ResponseWriter, r *http.Request) {
	if !p.authRequired() {
		writeJSON(w, http.StatusOK, map[string]any{
			"logged_in":     false,
			"auth_required": false,
			"reason":        "panel_auth_not_configured",
		})
		return
	}
	sess, ok := p.currentSession(r)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{
			"logged_in":     false,
			"auth_required": true,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"logged_in":     true,
		"auth_required": true,
		"user":          sess.User,
		"expires_at":    sess.Expires.Format(time.RFC3339),
	})
}
