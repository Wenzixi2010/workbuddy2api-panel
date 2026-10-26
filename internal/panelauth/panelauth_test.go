package panelauth

import (
	"testing"
	"time"
)

var creds = Credentials{Username: "wenzixi", Password: "514235mz"}

func TestLoginSuccessAndLookup(t *testing.T) {
	m := NewManager(time.Hour)
	tok, s, err := m.Login(creds, "wenzixi", "514235mz")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if tok == "" {
		t.Fatal("令牌为空")
	}
	if s.User != "wenzixi" {
		t.Errorf("User=%q want wenzixi", s.User)
	}
	got, ok := m.Lookup(tok)
	if !ok {
		t.Fatal("刚签发的会话查不到")
	}
	if got.User != s.User {
		t.Errorf("Lookup User=%q want %q", got.User, s.User)
	}
}

func TestLoginRejectsWrongCredentials(t *testing.T) {
	m := NewManager(time.Hour)
	for _, c := range []struct{ user, pass string }{
		{"wenzixi", "wrong"},
		{"wrong", "514235mz"},
		{"", ""},
		{"wenzixi", ""},
	} {
		if _, _, err := m.Login(creds, c.user, c.pass); err != ErrBadCredentials {
			t.Errorf("Login(%q,%q) err=%v want ErrBadCredentials", c.user, c.pass, err)
			// 失败后立刻置一个旧时间，避免节流挡住后续用例的判定
		}
		// 清掉节流状态，让下一个用例走到真正的凭据比较
		m.mu.Lock()
		m.lastFail = time.Time{}
		m.mu.Unlock()
	}
}

func TestLoginNotConfiguredNeverPasses(t *testing.T) {
	m := NewManager(time.Hour)
	// 空账号密码 = 未配置：必须报错，绝不能因为「空 == 空」而放行。
	_, _, err := m.Login(Credentials{}, "", "")
	if err != ErrNotConfigured {
		t.Fatalf("err=%v want ErrNotConfigured", err)
	}
	_, _, err = m.Login(Credentials{Username: "wenzixi"}, "wenzixi", "")
	if err != ErrNotConfigured {
		t.Fatalf("只配账号 err=%v want ErrNotConfigured", err)
	}
}

func TestSessionExpires(t *testing.T) {
	m := NewManager(time.Minute)
	now := time.Now()
	m.SetNow(func() time.Time { return now })

	tok, _, err := m.Login(creds, "wenzixi", "514235mz")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Lookup(tok); !ok {
		t.Fatal("未过期时应当有效")
	}

	now = now.Add(2 * time.Minute)
	if _, ok := m.Lookup(tok); ok {
		t.Fatal("过期后仍然有效")
	}
}

func TestLogoutInvalidates(t *testing.T) {
	m := NewManager(time.Hour)
	tok, _, err := m.Login(creds, "wenzixi", "514235mz")
	if err != nil {
		t.Fatal(err)
	}
	m.Logout(tok)
	if _, ok := m.Lookup(tok); ok {
		t.Fatal("登出后会话仍有效")
	}
	// 幂等：再登出一次不应 panic 或报错
	m.Logout(tok)
	m.Logout("")
}

func TestLogoutUserKillsAll(t *testing.T) {
	m := NewManager(time.Hour)
	t1, _, _ := m.Login(creds, "wenzixi", "514235mz")
	m.mu.Lock()
	m.lastFail = time.Time{}
	m.mu.Unlock()
	t2, _, err := m.Login(creds, "wenzixi", "514235mz")
	if err != nil {
		t.Fatalf("第二次登录: %v", err)
	}

	m.LogoutUser("wenzixi")
	if _, ok := m.Lookup(t1); ok {
		t.Error("t1 仍有效")
	}
	if _, ok := m.Lookup(t2); ok {
		t.Error("t2 仍有效")
	}
}

func TestTokenNotStoredInPlaintext(t *testing.T) {
	m := NewManager(time.Hour)
	tok, _, err := m.Login(creds, "wenzixi", "514235mz")
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	_, plaintext := m.sessions[tok]
	m.mu.Unlock()
	if plaintext {
		t.Fatal("会话表用明文令牌做键：内存泄漏即等于会话泄漏")
	}
}

func TestTokensAreUnique(t *testing.T) {
	m := NewManager(time.Hour)
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		m.mu.Lock()
		m.lastFail = time.Time{}
		m.mu.Unlock()
		tok, _, err := m.Login(creds, "wenzixi", "514235mz")
		if err != nil {
			t.Fatal(err)
		}
		if seen[tok] {
			t.Fatal("令牌重复")
		}
		seen[tok] = true
	}
}

func TestThrottleAfterFailure(t *testing.T) {
	m := NewManager(time.Hour)
	now := time.Now()
	m.SetNow(func() time.Time { return now })

	if _, _, err := m.Login(creds, "wenzixi", "bad"); err != ErrBadCredentials {
		t.Fatalf("err=%v want ErrBadCredentials", err)
	}
	// 立刻再试（哪怕密码对）应当被节流挡住。
	if _, _, err := m.Login(creds, "wenzixi", "514235mz"); err != ErrThrottled {
		t.Fatalf("err=%v want ErrThrottled", err)
	}
	// 过了间隔就恢复。
	now = now.Add(2 * time.Second)
	if _, _, err := m.Login(creds, "wenzixi", "514235mz"); err != nil {
		t.Fatalf("间隔后仍被挡: %v", err)
	}
}

func TestCountSweepsExpired(t *testing.T) {
	m := NewManager(time.Minute)
	now := time.Now()
	m.SetNow(func() time.Time { return now })

	if _, _, err := m.Login(creds, "wenzixi", "514235mz"); err != nil {
		t.Fatal(err)
	}
	if n := m.Count(); n != 1 {
		t.Fatalf("Count=%d want 1", n)
	}
	now = now.Add(2 * time.Minute)
	if n := m.Count(); n != 0 {
		t.Fatalf("过期后 Count=%d want 0", n)
	}
}
