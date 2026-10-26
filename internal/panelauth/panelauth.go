// Package panelauth 面板的账号密码登录与会话。
//
// 为什么从「Bearer api_key」换成「账号 + 会话」：面板是给人用的管理界面，
// 让人去配置文件里翻 api_key 再粘贴进来，既不方便也把网关密钥扩散到了一个
// 本不该需要它的地方。面板登录与网关鉴权现在是两条独立的链路——
// /v1/* 依旧只认 api_key，面板只认这里的会话。改动面板不会影响任何下游客户端。
//
// 安全设计的取舍：
//   - 会话令牌是 32 字节随机数，服务端只存它的 SHA-256：配置文件/内存被读走
//     也换不回可用的 Cookie（与「只存密码哈希」是同一个理由）。
//   - Cookie 是 HttpOnly + SameSite=Strict + Path=/panel：JS 读不到（XSS 拿不走），
//     跨站请求不带（CSRF 的基本面）。走 HTTPS 时再加 Secure（见 cookieSecure）。
//   - 密码比较用常量时间；账号密码都为空视为「未配置」，此时面板拒绝登录而不是
//     放行——把忘了配当成「开放访问」是最糟的失败模式。
//   - 登录失败有最小间隔（throttle），不让脚本在线爆破。
package panelauth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"
)

// CookieName 会话 Cookie 名。带前缀是为了不与网关/其它服务的 Cookie 撞名。
const CookieName = "wb2api_session"

// CookiePath 限定作用域：会话只发给面板，不随 /v1 请求外发。
const CookiePath = "/panel"

// DefaultTTL 会话有效期。管理面板不是高频入口，12 小时足够一个工作班次，
// 又不会长到「下班忘了登出、第二天还开着」。
const DefaultTTL = 12 * time.Hour

// ErrBadCredentials 账号或密码不对。对外只说这一句话，不区分「账号不存在」
// 与「密码错」——区分开等于给爆破者一个用户名枚举接口。
var ErrBadCredentials = errors.New("账号或密码不正确")

// ErrNotConfigured 面板未配置账号密码（配置里 panel_auth 为空）。
var ErrNotConfigured = errors.New("面板未配置登录账号")

// ErrThrottled 登录尝试过于频繁。
var ErrThrottled = errors.New("尝试过于频繁，请稍后再试")

// Credentials 面板登录凭据。零值表示未配置。
type Credentials struct {
	Username string
	Password string
}

// Configured 是否配置了登录账号（两者都非空才算）。
func (c Credentials) Configured() bool {
	return strings.TrimSpace(c.Username) != "" && c.Password != ""
}

// Session 一次登录会话。
type Session struct {
	// User 登录账号名（日志/界面展示用）。
	User string
	// Expires 过期时刻（UTC）。
	Expires time.Time
	// Created 建立时刻，用于「登录时长」展示与清理时的稳定性。
	Created time.Time
}

// Expired 会话是否已过期。
func (s Session) Expired(now time.Time) bool { return !now.Before(s.Expires) }

// Manager 会话存储。进程内内存态：面板是单实例进程，重启即全员登出——
// 这个行为是刻意的（重启往往伴随配置/二进制变更，重新认证一次更安全），
// 也省掉了「会话文件放哪、怎么清理」的一整套问题。
type Manager struct {
	mu       sync.Mutex
	sessions map[string]Session // key = 令牌的 SHA-256（hex）

	ttl       time.Duration
	now       func() time.Time
	lastFail  time.Time
	failDelay time.Duration
	failCount int
}

// NewManager 创建会话管理器；ttl <= 0 用 DefaultTTL。
func NewManager(ttl time.Duration) *Manager {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Manager{
		sessions: make(map[string]Session),
		ttl:      ttl,
		now:      time.Now,
		// 失败后的最小间隔：够挡住脚本爆破，又不至于让输错一次的人等太久。
		failDelay: 700 * time.Millisecond,
	}
}

// SetNow 注入时钟（测试用）。
func (m *Manager) SetNow(fn func() time.Time) { m.now = fn }

// TTL 当前会话有效期。
func (m *Manager) TTL() time.Duration { return m.ttl }

// Login 校验凭据并签发会话，返回明文令牌（只在此刻存在一次）。
func (m *Manager) Login(c Credentials, username, password string) (string, Session, error) {
	if !c.Configured() {
		return "", Session{}, ErrNotConfigured
	}

	m.mu.Lock()
	// 节流在锁内判定：并发爆破也拿不到「同时试很多次」的便宜。
	if !m.lastFail.IsZero() {
		if wait := m.failDelay - m.now().Sub(m.lastFail); wait > 0 {
			m.mu.Unlock()
			return "", Session{}, ErrThrottled
		}
	}
	m.mu.Unlock()

	// 账号与密码都要比：常量时间比较，且不因「账号先错」而提前返回。
	// 两次比较都执行，耗时形状不随哪个错而变化。
	userOK := constantEqual(username, c.Username)
	passOK := constantEqual(password, c.Password)

	if !userOK || !passOK {
		m.mu.Lock()
		m.lastFail = m.now()
		m.failCount++
		m.mu.Unlock()
		return "", Session{}, ErrBadCredentials
	}

	tok, err := newToken()
	if err != nil {
		return "", Session{}, err
	}
	now := m.now()
	s := Session{User: c.Username, Created: now, Expires: now.Add(m.ttl)}

	m.mu.Lock()
	m.lastFail = time.Time{}
	m.failCount = 0
	m.sweepLocked(now)
	m.sessions[hashToken(tok)] = s
	m.mu.Unlock()

	return tok, s, nil
}

// Lookup 用 Cookie 里的明文令牌查会话；过期或不存在返回 false。
func (m *Manager) Lookup(token string) (Session, bool) {
	if token == "" {
		return Session{}, false
	}
	key := hashToken(token)
	now := m.now()

	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		return Session{}, false
	}
	if s.Expired(now) {
		delete(m.sessions, key)
		return Session{}, false
	}
	return s, true
}

// Logout 使一个会话失效；令牌不存在时是空操作（登出要幂等）。
func (m *Manager) Logout(token string) {
	if token == "" {
		return
	}
	m.mu.Lock()
	delete(m.sessions, hashToken(token))
	m.mu.Unlock()
}

// LogoutUser 踢掉某账号的全部会话（改密码后调用，让旧会话立即失效）。
func (m *Manager) LogoutUser(user string) {
	m.mu.Lock()
	for k, s := range m.sessions {
		if s.User == user {
			delete(m.sessions, k)
		}
	}
	m.mu.Unlock()
}

// Count 当前有效会话数（概览展示用）。
func (m *Manager) Count() int {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sweepLocked(now)
	return len(m.sessions)
}

// sweepLocked 清掉过期会话（调用方持锁）。每次登录顺带清理，避免只增不减。
func (m *Manager) sweepLocked(now time.Time) {
	for k, s := range m.sessions {
		if s.Expired(now) {
			delete(m.sessions, k)
		}
	}
}

// newToken 生成 32 字节随机令牌（base64url 无填充，可直接进 Cookie）。
func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashToken 令牌摘要（存储键）。用摘要而非明文：内存被读走也换不回可用 Cookie。
func hashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// constantEqual 常量时间字符串比较（先摘要，长度差异被吸收）。
func constantEqual(a, b string) bool {
	da := sha256.Sum256([]byte(a))
	db := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(da[:], db[:]) == 1
}
