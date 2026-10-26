package panel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/misakano7545/workbuddy2api-panel/internal/gatewaykey"
)

// clientKeyPanel 造一个带客户 Key 存储的面板（api_key=test-key，其余依赖为 nil）。
// 路径用 os.MkdirTemp 而非 t.TempDir：本仓测试要能在旧 Go 上跑（见 gatewaykey 包测试注释）。
func clientKeyPanel(t *testing.T) *Panel {
	t.Helper()
	dir, err := os.MkdirTemp("", "panel-ck-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	store, err := gatewaykey.Open(filepath.Join(dir, "gateway_keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	return New(Config{Version: "test", APIKey: "test-key", ClientKeys: store,
		PanelAuth: func() (string, string) { return testUser, testPass }})
}

// call 发一次面板 API 请求（自动带 api_key）并返回状态码与解析后的 JSON。
func call(t *testing.T, p *Panel, method, path, body string) (int, map[string]any) {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	req.AddCookie(sessionFor(t, p))
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// 签发 → 列表（无明文）→ 轮换（旧明文失效）→ 删除 的完整往返。
func TestPanelClientKeysLifecycle(t *testing.T) {
	p := clientKeyPanel(t)

	code, created := call(t, p, "POST", "/panel/api/client_keys",
		`{"name":"团队A","remark":"备注","binds":["uid-a","uid-b"],"limits":{"period":"total","credits":12.5}}`)
	if code != 200 {
		t.Fatalf("create status=%d body=%v", code, created)
	}
	plain, _ := created["key"].(string)
	if !strings.HasPrefix(plain, gatewaykey.KeyPrefix) {
		t.Fatalf("create did not return a plaintext key: %v", created)
	}

	// 列表回显明文（key 字段）：应需求「后面也能看」，明文存档后列表直接可看。
	// 认证仍走 sha256，明文只用于管理面展示。
	_, list := call(t, p, "GET", "/panel/api/client_keys", "")
	keys, _ := list["keys"].([]any)
	if len(keys) != 1 {
		t.Fatalf("list keys=%v", list["keys"])
	}
	first, _ := keys[0].(map[string]any)
	if got, _ := first["key"].(string); got != plain {
		t.Fatalf("list key=%q, want plaintext %q（明文应可随时回显）", got, plain)
	}
	if first["name"] != "团队A" {
		t.Fatalf("list name=%v", first["name"])
	}
	binds, _ := first["binds"].([]any)
	if len(binds) != 2 {
		t.Fatalf("list binds=%v", first["binds"])
	}
	id, _ := first["id"].(string)
	if id == "" {
		t.Fatalf("list id empty: %v", first)
	}

	// 绑定确实落到存储里（认证层靠它选号），不是只存了展示字段。
	entry, err := p.cfg.ClientKeys.Authenticate(plain)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if len(entry.Binds()) != 2 {
		t.Fatalf("binds not stored: %v", entry.Binds())
	}
	if lim := entry.Limits(); lim.Credits != 12.5 || lim.Period != gatewaykey.PeriodTotal {
		t.Fatalf("limits not stored: %+v", lim)
	}

	// 改名 + 停用：只提交要改的字段，其余必须原样保留（Input 的指针语义）。
	code, upd := call(t, p, "POST", "/panel/api/client_keys/"+id, `{"name":"团队B","disabled":true}`)
	if code != 200 {
		t.Fatalf("update status=%d body=%v", code, upd)
	}
	view, _ := upd["client_key"].(map[string]any)
	if view["name"] != "团队B" || view["disabled"] != true {
		t.Fatalf("update result=%v", view)
	}
	if b, _ := view["binds"].([]any); len(b) != 2 {
		t.Fatalf("update clobbered binds: %v", view["binds"])
	}

	// 轮换：新明文可用，旧明文立刻失效。
	//
	// 注意上面刚把 Key 停用了，而「停用」是记录级状态、轮换只换摘要——所以
	// 新明文此刻仍应返回 ErrDisabled。要验证「能认证」必须先把停用解开，
	// 否则断言测的是另一件事。
	code, rot := call(t, p, "POST", "/panel/api/client_keys/"+id+"/rotate", "")
	if code != 200 {
		t.Fatalf("rotate status=%d body=%v", code, rot)
	}
	newPlain, _ := rot["key"].(string)
	if newPlain == "" || newPlain == plain {
		t.Fatalf("rotate did not mint a new key: %v", rot)
	}
	if _, err := p.cfg.ClientKeys.Authenticate(plain); err != gatewaykey.ErrInvalid {
		t.Fatalf("old key err=%v, want ErrInvalid after rotate", err)
	}
	if _, err := p.cfg.ClientKeys.Authenticate(newPlain); err != gatewaykey.ErrDisabled {
		t.Fatalf("new key err=%v, want ErrDisabled (key is still disabled)", err)
	}
	// 解开停用后新明文即可用（绑定与额度设置都保留）。
	if _, uerr := p.cfg.ClientKeys.Update(id, gatewaykey.Input{Disabled: ckBoolPtr(false)}); uerr != nil {
		t.Fatalf("re-enable: %v", uerr)
	}
	entry, aerr := p.cfg.ClientKeys.Authenticate(newPlain)
	if aerr != nil {
		t.Fatalf("new key does not authenticate after re-enable: %v", aerr)
	}
	if len(entry.Binds()) != 2 {
		t.Fatalf("rotate dropped binds: %v", entry.Binds())
	}

	// 删除：之后 404，明文也失效。
	code, _ = call(t, p, "POST", "/panel/api/client_keys/"+id+"/delete", "")
	if code != 200 {
		t.Fatalf("delete status=%d", code)
	}
	code, _ = call(t, p, "POST", "/panel/api/client_keys/"+id+"/delete", "")
	if code != http.StatusNotFound {
		t.Fatalf("second delete status=%d want 404", code)
	}
	if _, err := p.cfg.ClientKeys.Authenticate(newPlain); err == nil {
		t.Fatalf("deleted key still authenticates")
	}
}

// 额度重置要真的清掉本周期已用（累计总额度靠它「充值」）。
func TestPanelClientKeyResetUsage(t *testing.T) {
	p := clientKeyPanel(t)
	_, created := call(t, p, "POST", "/panel/api/client_keys",
		`{"name":"k","limits":{"period":"total","credits":10}}`)
	plain, _ := created["key"].(string)
	view, _ := created["client_key"].(map[string]any)
	id, _ := view["id"].(string)

	p.cfg.ClientKeys.Record(id, 7, true)
	if used := p.cfg.ClientKeys.List()[0].Used; used != 7 {
		t.Fatalf("used=%v want 7", used)
	}
	code, out := call(t, p, "POST", "/panel/api/client_keys/"+id+"/reset_usage", "")
	if code != 200 {
		t.Fatalf("reset status=%d body=%v", code, out)
	}
	if used := p.cfg.ClientKeys.List()[0].Used; used != 0 {
		t.Fatalf("used=%v after reset want 0", used)
	}
	if _, err := p.cfg.ClientKeys.Authenticate(plain); err != nil {
		t.Fatalf("key broken by reset: %v", err)
	}
}

// 空名称与非法额度必须在接口层就被拒（400），不能落盘成一把没法辨认的 Key。
func TestPanelClientKeyRejectsInvalidInput(t *testing.T) {
	p := clientKeyPanel(t)
	cases := []string{
		`{"name":""}`,
		`{"name":"x","limits":{"period":"week","credits":5}}`,
		`{"name":"x","limits":{"period":"total","credits":0}}`,
		`{"name":"x","limits":{"period":"day","credits":-1}}`,
	}
	for _, body := range cases {
		if code, out := call(t, p, "POST", "/panel/api/client_keys", body); code != http.StatusBadRequest {
			t.Fatalf("body %s status=%d want 400 (%v)", body, code, out)
		}
	}
}

// 存储缺失（未启用/载入失败）时列表要回 enabled=false + 说明，而不是 500 或空 200。
func TestPanelClientKeysWithoutStore(t *testing.T) {
	p := New(Config{Version: "test", APIKey: "test-key",
		PanelAuth: func() (string, string) { return testUser, testPass }})
	code, out := call(t, p, "GET", "/panel/api/client_keys", "")
	if code != 200 {
		t.Fatalf("status=%d want 200", code)
	}
	if out["enabled"] != false {
		t.Fatalf("enabled=%v want false", out["enabled"])
	}
	if s, _ := out["error"].(string); !strings.Contains(s, "未启用") {
		t.Fatalf("error hint missing: %v", out["error"])
	}
	if code, _ := call(t, p, "POST", "/panel/api/client_keys", `{"name":"x"}`); code != http.StatusNotImplemented {
		t.Fatalf("create without store status=%d want 501", code)
	}
}

// 开关关闭时不许签发：否则会出现「签发成功但立刻 401」的迷惑状态。
func TestPanelClientKeyCreateBlockedWhenDisabled(t *testing.T) {
	dir, err := os.MkdirTemp("", "panel-ck-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	store, err := gatewaykey.Open(filepath.Join(dir, "gateway_keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := New(Config{
		PanelAuth: func() (string, string) { return testUser, testPass },
		Version: "test", APIKey: "test-key", ClientKeys: store,
		ClientKeysEnabled: func() bool { return false },
	})
	code, out := call(t, p, "POST", "/panel/api/client_keys", `{"name":"x"}`)
	if code != http.StatusConflict {
		t.Fatalf("create while disabled status=%d body=%v want 409", code, out)
	}
	// 列表仍然可读（要能看到已有 Key 并解释它们为什么不生效）。
	if code, out := call(t, p, "GET", "/panel/api/client_keys", ""); code != 200 || out["enabled"] != false {
		t.Fatalf("list while disabled code=%d out=%v", code, out)
	}
}

// 面板鉴权边界：**客户 Key 不能当面板钥匙用**。
//
// 这条边界在改造成账号登录后变得更强了：面板只认会话 Cookie，客户端 Key
// （以及网关主密钥）连不上来。这里用「拿着客户 Key 明文、但不带会话」请求
// 面板 API，必须 401。
func TestClientKeyCannotOpenPanel(t *testing.T) {
	p := clientKeyPanel(t)
	// 直接经存储层签发，绕开面板接口——这里要验证的正是「没有会话就连
	// 管理接口都进不去」，用 call() 建 Key 会自相矛盾。
	name := "k"
	plain, _, err := p.cfg.ClientKeys.Create(gatewaykey.Input{Name: &name})
	if err != nil {
		t.Fatalf("签发客户 Key: %v", err)
	}

	for _, header := range []string{"Bearer " + plain, "Bearer test-key"} {
		req := httptest.NewRequest("GET", "/panel/api/client_keys", nil)
		req.Header.Set("Authorization", header)
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("Authorization=%q 居然进了面板 API: status=%d", header, rec.Code)
		}
	}
}

// ckBoolPtr 取 *bool（gatewaykey.Input 用指针区分「未提供」与「设为 false」）。
func ckBoolPtr(b bool) *bool { return &b }
