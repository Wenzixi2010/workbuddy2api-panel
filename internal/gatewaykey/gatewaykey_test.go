package gatewaykey

// 说明：本仓目标 Go 1.26，但开发机可能只有更老的工具链做语法自检（go vet/parse），
// 所以本文件的测试辅助**刻意只用** t.Fatal/t.Run/t.Cleanup 这些老 API：
// 不依赖 t.TempDir / t.Setenv / os.WriteFile / strings.Cut。等确认能在 Go 1.26 上跑
// 后，若想用新 API 再换，不影响被测逻辑。

import (
	"io/ioutil"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/cst"
)

// tempFile 在临时目录里返回一个尚不存在的文件路径。
func tempFile(t *testing.T, name string) string {
	t.Helper()
	dir, err := ioutil.TempDir("", "gatewaykey")
	if err != nil {
		t.Fatalf("tempdir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, name)
}

func strp(s string) *string { return &s }

func TestCreateAuthenticateLifecycle(t *testing.T) {
	path := tempFile(t, "gateway_keys.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	plain, v, err := s.Create(Input{Name: strp("客户 A")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(plain) < len(KeyPrefix)+20 || plain[:len(KeyPrefix)] != KeyPrefix {
		t.Fatalf("plain key = %q, want %s prefix + 长随机段", plain, KeyPrefix)
	}
	if v.Name != "客户 A" || v.Remaining != -1 {
		t.Fatalf("view = %+v, want 不限额(remaining=-1)", v)
	}

	e, err := s.Authenticate(plain)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if e.ID() != v.ID || e.Bound() {
		t.Fatalf("entry = id %q bound %v, want id %q 未绑定", e.ID(), e.Bound(), v.ID)
	}

	// 不认识的 key 必须 ErrInvalid，且不能是「空 key 放行」那种漏洞。
	if _, err := s.Authenticate("gw-nope"); err != ErrInvalid {
		t.Fatalf("unknown key err = %v, want ErrInvalid", err)
	}
	if _, err := s.Authenticate(""); err != ErrInvalid {
		t.Fatalf("empty key err = %v, want ErrInvalid", err)
	}

	// 落盘的是摘要而不是明文：文件里不能出现明文。
	raw, rerr := ioutil.ReadFile(path)
	if rerr != nil {
		t.Fatalf("read file: %v", rerr)
	}
	if containsBytes(raw, []byte(plain)) {
		t.Fatal("明文 key 出现在落盘文件里——只应保存 sha256 摘要")
	}

	// 重启后仍可认证（摘要稳定）。
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if _, err := s2.Authenticate(plain); err != nil {
		t.Fatalf("authenticate after reopen: %v", err)
	}
}

func containsBytes(hay, needle []byte) bool {
	if len(needle) == 0 || len(hay) < len(needle) {
		return false
	}
	for i := 0; i+len(needle) <= len(hay); i++ {
		match := true
		for j := range needle {
			if hay[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func TestBindsAndClaimed(t *testing.T) {
	s, err := Open(tempFile(t, "k.json"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	binds := []string{" uid-b ", "uid-a", "uid-b", ""}
	_, v, err := s.Create(Input{Name: strp("独占"), Binds: &binds})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	want := []string{"uid-a", "uid-b"} // 去空白、去重、排序
	if len(v.Binds) != len(want) || v.Binds[0] != want[0] || v.Binds[1] != want[1] {
		t.Fatalf("binds = %v, want %v", v.Binds, want)
	}
	claimed := s.Claimed()
	if len(claimed) != 2 {
		t.Fatalf("claimed = %v, want 两个 uid", claimed)
	}
	if _, ok := claimed["uid-a"]; !ok {
		t.Fatal("uid-a 未被 claim")
	}

	// 删除后 claims 必须收缩（否则号会被永久锁在「专属」里，谁都选不到）。
	if ok, err := s.Delete(v.ID); !ok || err != nil {
		t.Fatalf("delete = %v, %v", ok, err)
	}
	if len(s.Claimed()) != 0 {
		t.Fatalf("删除后 claimed 未清空: %v", s.Claimed())
	}
}

func TestLimitsDayRolling(t *testing.T) {
	s, err := Open(tempFile(t, "k.json"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	limits := Limits{Period: PeriodDay, Credits: 10}
	plain, v, err := s.Create(Input{Name: strp("日额"), Limits: &limits})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	s.Record(v.ID, 4, true)
	s.Record(v.ID, 0, false) // 未知不扣，但要计未知次数
	got, _ := s.Get(v.ID)
	if got.Used != 4 || got.UnknownCredits != 1 {
		t.Fatalf("used=%v unknown=%d, want 4 / 1", got.Used, got.UnknownCredits)
	}
	if got.Remaining != 6 || got.Exhausted {
		t.Fatalf("remaining=%v exhausted=%v, want 6 / false", got.Remaining, got.Exhausted)
	}

	// 只累加实测 credit：observed=false 的 credit 值必须被忽略。
	s.Record(v.ID, 99, false)
	if got, _ := s.Get(v.ID); got.Used != 4 {
		t.Fatalf("未观测 credit 被计入额度: used=%v", got.Used)
	}

	s.Record(v.ID, 6, true)
	got, _ = s.Get(v.ID)
	if !got.Exhausted || got.Remaining != 0 {
		t.Fatalf("用尽后 exhausted=%v remaining=%v, want true / 0", got.Exhausted, got.Remaining)
	}

	// 跨日滚动：把游标改成昨天，views 读路径应自动归零。
	s.mu.Lock()
	s.usage[v.ID].day = cst.Day(time.Now().AddDate(0, 0, -1))
	s.mu.Unlock()
	got, _ = s.Get(v.ID)
	if got.Used != 0 || got.Exhausted {
		t.Fatalf("跨日后 used=%v exhausted=%v, want 0 / false", got.Used, got.Exhausted)
	}

	// 认证返回的快照也要按日滚动（请求路径判额直接用快照）。
	e, err := s.Authenticate(plain)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if e.Exhausted() {
		t.Fatal("新的一天的 Key 在认证快照里仍是超额状态")
	}
	if e.Remaining() != 10 {
		t.Fatalf("remaining = %v, want 10", e.Remaining())
	}
}

func TestLimitsTotalNotRolledByDay(t *testing.T) {
	s, err := Open(tempFile(t, "k.json"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	limits := Limits{Period: PeriodTotal, Credits: 5}
	_, v, err := s.Create(Input{Name: strp("总额"), Limits: &limits})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	s.Record(v.ID, 5, true)
	s.mu.Lock()
	s.usage[v.ID].day = "2000-01-01"
	s.mu.Unlock()
	got, _ := s.Get(v.ID)
	if got.Used != 5 || !got.Exhausted {
		t.Fatalf("total 周期被日界滚动: used=%v exhausted=%v", got.Used, got.Exhausted)
	}

	// 重置额度：总额度显式归零。
	got, err = s.ResetUsage(v.ID)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	if got.Used != 0 || got.Exhausted {
		t.Fatalf("重置后 used=%v exhausted=%v, want 0 / false", got.Used, got.Exhausted)
	}
	// 累计请求数描述「发生过什么」，重置额度不清它。
	if got.Requests != 1 {
		t.Fatalf("requests = %d, want 1（重置额度不应抹掉请求统计）", got.Requests)
	}
}

func TestValidateLimits(t *testing.T) {
	cases := []struct {
		name string
		in   Limits
		ok   bool
	}{
		{"不限额", Limits{}, true},
		{"不限额但带冗余 credits（归零）", Limits{Credits: 9}, true},
		{"日额", Limits{Period: PeriodDay, Credits: 1}, true},
		{"总额", Limits{Period: PeriodTotal, Credits: 100}, true},
		{"设了周期但上限 0", Limits{Period: PeriodDay, Credits: 0}, false},
		{"负上限", Limits{Period: PeriodTotal, Credits: -1}, false},
		{"非法周期", Limits{Period: LimitPeriod("week"), Credits: 1}, false},
		{"上限过大", Limits{Period: PeriodTotal, Credits: 1e10}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := validateLimits(c.in)
			if (err == nil) != c.ok {
				t.Fatalf("validateLimits(%+v) err = %v, want ok=%v", c.in, err, c.ok)
			}
		})
	}
}

func TestDisabledKeyStillRecognised(t *testing.T) {
	s, err := Open(tempFile(t, "k.json"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	plain, v, err := s.Create(Input{Name: strp("停用")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	dis := true
	if _, err := s.Update(v.ID, Input{Disabled: &dis}); err != nil {
		t.Fatalf("update: %v", err)
	}
	// 停用 ≠ 不认识：调用方要能给出「已停用」而不是「无效 Key」，否则客户会去重抄一遍 Key。
	if _, err := s.Authenticate(plain); err != ErrDisabled {
		t.Fatalf("disabled key err = %v, want ErrDisabled", err)
	}
	dis = false
	if _, err := s.Update(v.ID, Input{Disabled: &dis}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, err := s.Authenticate(plain); err != nil {
		t.Fatalf("重新启用后仍不可用: %v", err)
	}
}

func TestRotateInvalidatesOldPlain(t *testing.T) {
	s, err := Open(tempFile(t, "k.json"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	oldPlain, v, err := s.Create(Input{Name: strp("轮换")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	newPlain, nv, err := s.Rotate(v.ID)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if newPlain == oldPlain {
		t.Fatal("轮换后明文未变化")
	}
	if nv.ID != v.ID {
		t.Fatalf("轮换改变了 id：%q → %q", v.ID, nv.ID)
	}
	if _, err := s.Authenticate(oldPlain); err != ErrInvalid {
		t.Fatalf("旧明文仍可认证: %v", err)
	}
	if _, err := s.Authenticate(newPlain); err != nil {
		t.Fatalf("新明文不可认证: %v", err)
	}
}

func TestCorruptFileFallsBackToBak(t *testing.T) {
	path := tempFile(t, "k.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	plain, _, err := s.Create(Input{Name: strp("备份")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// 再写一次，产生 .bak（第一版内容）。
	if _, _, err := s.Create(Input{Name: strp("第二个")}); err != nil {
		t.Fatalf("create2: %v", err)
	}
	// 模拟掉电：正文写成空文件，.bak 仍完好。
	if err := ioutil.WriteFile(path, []byte{}, 0o600); err != nil {
		t.Fatalf("corrupt: %v", err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("损坏后未回退 .bak: %v", err)
	}
	if _, err := s2.Authenticate(plain); err != nil {
		t.Fatalf("回退 .bak 后第一个 Key 不可认证: %v", err)
	}
}

func TestEmptyNameRejected(t *testing.T) {
	s, _ := Open(tempFile(t, "k.json"))
	if _, _, err := s.Create(Input{Name: strp("   ")}); err == nil {
		t.Fatal("空名称应被拒绝（列表无法辨认是哪把 Key）")
	}
	if _, _, err := s.Create(Input{}); err == nil {
		t.Fatal("缺名称应被拒绝")
	}
}

func TestHasNoClaimsWhenNoBinds(t *testing.T) {
	s, _ := Open(tempFile(t, "k.json"))
	if s.Claimed() != nil {
		t.Fatal("没有任何 Key 时 Claimed 应为 nil（选号热路径零分配）")
	}
	if _, _, err := s.Create(Input{Name: strp("共享")}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if s.Claimed() != nil {
		t.Fatal("只建了未绑号的 Key，Claimed 仍应为 nil")
	}
}

func TestUpdateBindsRefreshesClaims(t *testing.T) {
	s, _ := Open(tempFile(t, "k.json"))
	_, v, err := s.Create(Input{Name: strp("切换绑定")})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	b := []string{"u1"}
	if _, err := s.Update(v.ID, Input{Binds: &b}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, ok := s.Claimed()["u1"]; !ok {
		t.Fatal("绑定后 u1 未被 claim")
	}
	empty := []string{}
	if _, err := s.Update(v.ID, Input{Binds: &empty}); err != nil {
		t.Fatalf("update2: %v", err)
	}
	if len(s.Claimed()) != 0 {
		t.Fatalf("解绑后 claims 未清空: %v", s.Claimed())
	}
}
