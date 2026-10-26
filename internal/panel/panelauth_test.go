package panel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/panelauth"
	"github.com/misakano7545/workbuddy2api-panel/internal/pool"
)

const (
	testUser = "wenzixi"
	testPass = "514235mz"
)

// withPanelAuth 给测试面板装上账号密码登录。
func withPanelAuth(p *Panel) *Panel {
	p.cfg.PanelAuth = func() (string, string) { return testUser, testPass }
	p.cfg.PanelSessionTTL = func() time.Duration { return time.Hour }
	return p
}

// loginPanel 走一次真实登录，返回带会话 Cookie 的请求构造器。
func loginPanel(t *testing.T, p *Panel) func(method, path string, body string) *http.Request {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/panel/api/login", strings.NewReader(
		`{"username":"`+testUser+`","password":"`+testPass+`"}`))
	p.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("登录失败 code=%d body=%s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("登录成功但没有下发 Cookie")
	}
	return func(method, path, body string) *http.Request {
		var r *http.Request
		if body == "" {
			r = httptest.NewRequest(method, path, nil)
		} else {
			r = httptest.NewRequest(method, path, strings.NewReader(body))
		}
		for _, c := range cookies {
			r.AddCookie(c)
		}
		return r
	}
}

// 未登录访问面板 API 必须 401，且错误码是 login_required（不是 api_key 那套）。
func TestPanelAPIRequiresLogin(t *testing.T) {
	p := withPanelAuth(newTestPanel())
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/panel/api/overview", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code=%d want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "login_required") {
		t.Errorf("body=%s want login_required", rec.Body.String())
	}
}

// 带上会话 Cookie 后必须放行。
//
// 用一个**有 Pool** 的面板：overview 会去读账号统计，空 Pool 会直接空指针。
// 这里要验证的是鉴权层，不是 overview 的数据，所以给个最小的空池即可。
func TestPanelAPIAcceptsSessionCookie(t *testing.T) {
	p := withPanelAuth(New(Config{
		Version:   "test",
		Pool:      pool.New(""),
		PanelAuth: func() (string, string) { return testUser, testPass },
	}))
	mk := loginPanel(t, p)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, mk("GET", "/panel/api/session", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s want 200", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"logged_in":true`) {
		t.Errorf("body=%s want logged_in true", rec.Body.String())
	}
}

// 账号或密码错误一律 401 bad_credentials，且不泄露「账号是否存在」。
func TestPanelLoginRejectsBadCredentials(t *testing.T) {
	p := withPanelAuth(newTestPanel())
	for _, body := range []string{
		`{"username":"wenzixi","password":"nope"}`,
		`{"username":"nobody","password":"514235mz"}`,
		`{}`,
	} {
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, httptest.NewRequest("POST", "/panel/api/login", strings.NewReader(body)))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("body=%s code=%d want 401", body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "bad_credentials") {
			t.Errorf("body=%s resp=%s want bad_credentials", body, rec.Body.String())
		}
		// 失败后清掉节流，避免下一条用例被挡成 429
		p.auth = panelauth.NewManager(time.Hour)
	}
}

// 会话 Cookie 必须是 HttpOnly + SameSite=Strict + Path=/panel。
//
// 这三项不是「顺手加上」的：HttpOnly 挡 XSS 偷令牌，SameSite=Strict 是 CSRF 的
// 基本面，Path=/panel 保证它不会随 /v1 请求外发。任何一项丢了都是实打实的安全退化。
func TestSessionCookieAttributes(t *testing.T) {
	p := withPanelAuth(newTestPanel())
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("POST", "/panel/api/login", strings.NewReader(
		`{"username":"`+testUser+`","password":"`+testPass+`"}`)))
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("Cookie 数量=%d want 1", len(cookies))
	}
	c := cookies[0]
	if c.Name != panelauth.CookieName {
		t.Errorf("name=%q want %q", c.Name, panelauth.CookieName)
	}
	if !c.HttpOnly {
		t.Error("会话 Cookie 必须是 HttpOnly（否则 XSS 能读走令牌）")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Errorf("SameSite=%v want Strict", c.SameSite)
	}
	if c.Path != "/panel" {
		t.Errorf("Path=%q want /panel", c.Path)
	}
}

// 响应体里不能出现令牌明文（令牌只走 Cookie）。
func TestLoginResponseHasNoToken(t *testing.T) {
	p := withPanelAuth(newTestPanel())
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("POST", "/panel/api/login", strings.NewReader(
		`{"username":"`+testUser+`","password":"`+testPass+`"}`)))
	tok := rec.Result().Cookies()[0].Value
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	for k, v := range got {
		if s, ok := v.(string); ok && s == tok {
			t.Errorf("响应体字段 %s 泄露了会话令牌", k)
		}
	}
}

// 登出后同一 Cookie 必须失效，且登出本身幂等。
func TestLogoutInvalidatesSession(t *testing.T) {
	p := withPanelAuth(newTestPanel())
	mk := loginPanel(t, p)

	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, mk("POST", "/panel/api/logout", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("登出 code=%d", rec.Code)
	}

	again := httptest.NewRecorder()
	p.ServeHTTP(again, mk("GET", "/panel/api/overview", ""))
	if again.Code != http.StatusUnauthorized {
		t.Fatalf("登出后仍可访问：code=%d", again.Code)
	}

	// 再登出一次（幂等）
	twice := httptest.NewRecorder()
	p.ServeHTTP(twice, mk("POST", "/panel/api/logout", ""))
	if twice.Code != http.StatusOK {
		t.Errorf("重复登出 code=%d want 200", twice.Code)
	}
}

// session 接口：未登录返回 200 + logged_in:false（前端靠它决定渲染登录页）。
func TestSessionEndpointReportsState(t *testing.T) {
	p := withPanelAuth(newTestPanel())

	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/panel/api/session", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("未登录时 session code=%d want 200", rec.Code)
	}
	var s map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	if s["logged_in"] != false {
		t.Errorf("logged_in=%v want false", s["logged_in"])
	}
	if s["auth_required"] != true {
		t.Errorf("auth_required=%v want true", s["auth_required"])
	}

	mk := loginPanel(t, p)
	rec2 := httptest.NewRecorder()
	p.ServeHTTP(rec2, mk("GET", "/panel/api/session", ""))
	var s2 map[string]any
	if err := json.Unmarshal(rec2.Body.Bytes(), &s2); err != nil {
		t.Fatal(err)
	}
	if s2["logged_in"] != true {
		t.Errorf("登录后 logged_in=%v want true", s2["logged_in"])
	}
	if s2["user"] != testUser {
		t.Errorf("user=%v want %s", s2["user"], testUser)
	}
}

// 未配置账号密码时：必须拒绝登录，而不是放行。
//
// 这是这次改动最容易犯的错：把「忘了配」当成「开放访问」。面板能改配置、
// 能停用账号、能签发 Key，绝不能因为一个空配置就敞开。
func TestPanelAuthNotConfiguredFailsClosed(t *testing.T) {
	// 刻意不配 PanelAuth：模拟「配置文件里忘了写」的部署。
	p := New(Config{Version: "test", Pool: pool.New("")})
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/panel/api/overview", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未配置账号时 code=%d want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "panel_auth_not_configured") {
		t.Errorf("body=%s want panel_auth_not_configured", rec.Body.String())
	}

	// 登录接口同样要拒绝，并给出可操作的错误码。
	rec2 := httptest.NewRecorder()
	p.ServeHTTP(rec2, httptest.NewRequest("POST", "/panel/api/login", strings.NewReader(
		`{"username":"any","password":"any"}`)))
	if rec2.Code == http.StatusOK {
		t.Fatal("未配置账号时登录居然成功了")
	}
	if !strings.Contains(rec2.Body.String(), "panel_auth_not_configured") {
		t.Errorf("body=%s want panel_auth_not_configured", rec2.Body.String())
	}
}

// 篡改过的会话令牌必须无效。
func TestForgedSessionRejected(t *testing.T) {
	p := withPanelAuth(newTestPanel())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/panel/api/overview", nil)
	req.AddCookie(&http.Cookie{Name: panelauth.CookieName, Value: "forged-token-value"})
	p.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("伪造令牌 code=%d want 401", rec.Code)
	}
}

// 网关 api_key 不能再当面板钥匙用（两条鉴权链路已分家）。
func TestGatewayAPIKeyNoLongerOpensPanel(t *testing.T) {
	p := withPanelAuth(newTestPanel())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/panel/api/overview", nil)
	req.Header.Set("Authorization", "Bearer "+p.apiKey())
	p.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("api_key 仍能进面板：code=%d（面板应与网关鉴权彻底分开）", rec.Code)
	}
}

// sessionFor 直接为面板签一个会话 Cookie（跳过登录接口）。
//
// 用途：既有的大量用例原本用 `Header.Set("Authorization", "Bearer ...")` 表达
// 「这个请求是已鉴权的」。鉴权换成会话 Cookie 后，这些用例的**意图**没变
// （都是「以合法身份访问」），只是载体变了。让一个 helper 把这件事做掉，
// 比逐文件改写请求构造更不容易出错。
func sessionFor(t *testing.T, p *Panel) *http.Cookie {
	t.Helper()
	tok, _, err := p.auth.Login(p.credentials(), testUser, testPass)
	if err != nil {
		t.Fatalf("签发测试会话失败: %v（该面板是否配了 PanelAuth？）", err)
	}
	return &http.Cookie{Name: panelauth.CookieName, Value: tok}
}

// authedPanel 返回一个已登录的面板与「带会话的请求构造器」。
func authedPanel(t *testing.T) (*Panel, func(method, path, body string) *http.Request) {
	t.Helper()
	p := newTestPanel()
	mk := loginPanel(t, p)
	return p, mk
}
