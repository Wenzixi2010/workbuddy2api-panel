package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/misakano7545/workbuddy2api-panel/internal/gatewaykey"
	"github.com/misakano7545/workbuddy2api-panel/internal/livecfg"
	"github.com/misakano7545/workbuddy2api-panel/internal/pool"
)

// clientKeyHandler 造一个启用客户 Key 的最小 handler（无上游：认证层的用例
// 不该为了拿一个 401/429 去打网络）。
func clientKeyHandler(t *testing.T, enabled bool) (*Handler, *gatewaykey.Store) {
	t.Helper()
	dir, err := os.MkdirTemp("", "srv-ck-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	store, err := gatewaykey.Open(filepath.Join(dir, "gateway_keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(Config{
		Pool:       pool.New(""),
		APIKey:     "master-key",
		ClientKeys: store,
		Live:       livecfg.New(livecfg.Snapshot{APIKey: "master-key", ClientKeysEnabled: enabled}),
	})
	return h, store
}

// 主密钥照旧放行（空 key = 不鉴权、常量时间比较等既有行为不能被这次改动带偏）。
func TestAuthorizedClientMasterKeyUnchanged(t *testing.T) {
	h, _ := clientKeyHandler(t, true)
	req := httptest.NewRequest("GET", "/status", nil)
	req.Header.Set("Authorization", "Bearer master-key")
	if _, why := h.authorizedClient(req); why != "" {
		t.Fatalf("master key rejected: %s", why)
	}
	req.Header.Set("Authorization", "Bearer wrong")
	if _, why := h.authorizedClient(req); why == "" {
		t.Fatal("wrong key accepted")
	}
}

// 客户 Key 必须能通过认证，并且身份被带进 context（后续按它取绑定与额度）。
func TestAuthorizedClientAcceptsClientKey(t *testing.T) {
	h, store := clientKeyHandler(t, true)
	plain, view, err := store.Create(gatewaykey.Input{Name: strPtr("k1")})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/status", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	r2, why := h.authorizedClient(req)
	if why != "" {
		t.Fatalf("client key rejected: %s", why)
	}
	id := identityFrom(r2)
	if id == nil || id.entry == nil {
		t.Fatal("identity not attached to request")
	}
	if id.entry.ID() != view.ID {
		t.Fatalf("identity id=%s want %s", id.entry.ID(), view.ID)
	}
	if got := clientKeyLabel(r2); got == "" {
		t.Fatal("archive label empty for client key request")
	}
}

// 开关关闭 = 一次性收回全部客户 Key（但主密钥不受影响）。
func TestAuthorizedClientRejectsWhenDisabled(t *testing.T) {
	h, store := clientKeyHandler(t, false)
	plain, _, err := store.Create(gatewaykey.Input{Name: strPtr("k1")})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/status", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	if _, why := h.authorizedClient(req); why == "" {
		t.Fatal("client key accepted while client_keys.enabled=false")
	}
	req.Header.Set("Authorization", "Bearer master-key")
	if _, why := h.authorizedClient(req); why != "" {
		t.Fatalf("master key must stay valid when client keys are off: %s", why)
	}
}

// 停用单把 Key：拒绝并给出可分辨的原因（客户端据此决定找人还是改配置）。
func TestAuthorizedClientRejectsDisabledKey(t *testing.T) {
	h, store := clientKeyHandler(t, true)
	plain, view, err := store.Create(gatewaykey.Input{Name: strPtr("k1")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Update(view.ID, gatewaykey.Input{Disabled: boolPtr(true)}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/status", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	_, why := h.authorizedClient(req)
	if !strings.Contains(why, "disabled") {
		t.Fatalf("disabled key reason=%q want it to say disabled", why)
	}
}

// 绑定型 Key 的选号过滤器：只有白名单（换成未绑定流量则改为排除别人独占的号）。
func TestClientKeyFilterShapes(t *testing.T) {
	h, store := clientKeyHandler(t, true)
	bound, _, err := store.Create(gatewaykey.Input{Name: strPtr("bound"), Binds: &[]string{"a", "b"}})
	if err != nil {
		t.Fatal(err)
	}
	free, _, err := store.Create(gatewaykey.Input{Name: strPtr("free")})
	if err != nil {
		t.Fatal(err)
	}

	reqBound := httptest.NewRequest("GET", "/status", nil)
	reqBound.Header.Set("Authorization", "Bearer "+bound)
	r2, _ := h.authorizedClient(reqBound)
	f := h.clientKeyFilter(r2)
	if len(f.Allow) != 2 || len(f.ExcludeClaimed) != 0 {
		t.Fatalf("bound key filter=%+v want allow{a,b}", f)
	}

	reqFree := httptest.NewRequest("GET", "/status", nil)
	reqFree.Header.Set("Authorization", "Bearer "+free)
	r3, _ := h.authorizedClient(reqFree)
	f2 := h.clientKeyFilter(r3)
	if len(f2.Allow) != 0 || len(f2.ExcludeClaimed) != 2 {
		t.Fatalf("unbound key filter=%+v want exclude{a,b}", f2)
	}

	// 主密钥：不施加任何约束（老行为逐字不变）。
	reqMaster := httptest.NewRequest("GET", "/status", nil)
	reqMaster.Header.Set("Authorization", "Bearer master-key")
	r4, _ := h.authorizedClient(reqMaster)
	if f3 := h.clientKeyFilter(r4); !f3.Empty() {
		t.Fatalf("master key filter=%+v want zero value", f3)
	}
}

// 额度用尽要拦住请求（429 + 明确 code），不能等到上游扣费之后再说。
func TestClientKeyExhaustedBlocks(t *testing.T) {
	h, store := clientKeyHandler(t, true)
	plain, view, err := store.Create(gatewaykey.Input{
		Name:   strPtr("q"),
		Limits: &gatewaykey.Limits{Period: gatewaykey.PeriodTotal, Credits: 5},
	})
	if err != nil {
		t.Fatal(err)
	}
	store.Record(view.ID, 5, true) // 刚好用满

	req := httptest.NewRequest("GET", "/status", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	r2, _ := h.authorizedClient(req)
	bad, why := h.clientKeyExhausted(r2)
	if !bad {
		t.Fatal("exhausted key not blocked")
	}
	if !strings.Contains(why, "quota") {
		t.Fatalf("exhausted reason=%q", why)
	}

	// 重置后应放行（累计额度靠它「充值」）。
	if _, err := store.ResetUsage(view.ID); err != nil {
		t.Fatal(err)
	}
	r3, _ := h.authorizedClient(req)
	if bad, _ := h.clientKeyExhausted(r3); bad {
		t.Fatal("key still blocked after usage reset")
	}
}

// 用量记账：已观测的 credit 才累加，未知只计数（与「未知不扣」的口径一致）。
func TestRecordClientKeyUsageCountsObservedOnly(t *testing.T) {
	h, store := clientKeyHandler(t, true)
	plain, view, err := store.Create(gatewaykey.Input{
		Name:   strPtr("q"),
		Limits: &gatewaykey.Limits{Period: gatewaykey.PeriodTotal, Credits: 100},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/status", nil)
	req.Header.Set("Authorization", "Bearer "+plain)
	r2, _ := h.authorizedClient(req)

	h.recordClientKeyUsage(r2, 2.5, true)
	h.recordClientKeyUsage(r2, 0, false)
	h.recordClientKeyUsage(r2, 0, false)

	v, ok := store.Get(view.ID)
	if !ok {
		t.Fatal("key disappeared")
	}
	if v.Used != 2.5 {
		t.Fatalf("used=%v want 2.5 (unknown credits must not be charged)", v.Used)
	}
	if v.Requests != 3 || v.UnknownCredits != 2 {
		t.Fatalf("requests=%d unknown=%d want 3/2", v.Requests, v.UnknownCredits)
	}
}

func strPtr(s string) *string  { return &s }
func boolPtr(b bool) *bool     { return &b }
