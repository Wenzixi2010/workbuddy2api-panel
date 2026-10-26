package pool

import (
	"testing"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/auth"
)

// uidSet 便捷构造白名单/排除集。
func uidSet(uids ...string) map[string]struct{} {
	out := make(map[string]struct{}, len(uids))
	for _, u := range uids {
		out[u] = struct{}{}
	}
	return out
}

// 绑定型客户 Key：只能从自己的账号里选，池里其他号一律不碰。
//
// 这条断言是「独占」语义的正面；反面（别人的号不服务未绑定流量）见下一个测试。
func TestPickFilterAllowOnlyReturnsBoundAccounts(t *testing.T) {
	withNoPickGap(t)
	p := New("")
	for _, uid := range []string{"a", "b", "c"} {
		p.Add(&auth.Auth{UID: uid})
	}
	f := PickFilter{Allow: uidSet("b")}
	for i := 0; i < 200; i++ {
		acct := p.PickExcludingForRealmFiltered(nil, "", "", f)
		if acct == nil || acct.UID != "b" {
			t.Fatalf("pick=%v want only the bound account b", acct)
		}
	}
}

// 绑定的号全不可用时返回 nil（而不是"回落到全池"）：回退会让独占变成一句空话——
// 绑定只是偏好而非隔离，别人仍能被借用。
func TestPickFilterAllowFallsBackToNothing(t *testing.T) {
	p := New("")
	p.Add(&auth.Auth{UID: "a"})
	p.Add(&auth.Auth{UID: "b"})
	p.Disable("b", "test")
	if acct := p.PickExcludingForRealmFiltered(nil, "", "", PickFilter{Allow: uidSet("b")}); acct != nil {
		t.Fatalf("pick=%v want nil (bound account disabled, must not fall back to a)", acct)
	}
}

// 未绑定流量要避开被客户 Key 独占的号：否则「绑定」在别人的请求上完全无效。
func TestPickFilterExcludeClaimedSkipsBoundAccounts(t *testing.T) {
	withNoPickGap(t)
	p := New("")
	p.Add(&auth.Auth{UID: "a"})
	p.Add(&auth.Auth{UID: "b"})
	f := PickFilter{ExcludeClaimed: uidSet("a")}
	for i := 0; i < 200; i++ {
		acct := p.PickExcludingForRealmFiltered(nil, "", "", f)
		if acct == nil || acct.UID != "b" {
			t.Fatalf("pick=%v want b (a is claimed by a client key)", acct)
		}
	}
}

// 全池都被独占且本次请求没有绑定时返回 nil：宁可 503，也不把独占号借出去。
func TestPickFilterExcludeClaimedReturnsNilWhenAllClaimed(t *testing.T) {
	p := New("")
	p.Add(&auth.Auth{UID: "a"})
	f := PickFilter{ExcludeClaimed: uidSet("a")}
	if acct := p.PickExcludingForRealmFiltered(nil, "", "", f); acct != nil {
		t.Fatalf("pick=%v want nil", acct)
	}
}

// 零值过滤器必须与旧行为逐字一致（主密钥与未启用客户 Key 的路径都走零值）。
func TestPickFilterZeroValueKeepsLegacyBehaviour(t *testing.T) {
	withNoPickGap(t)
	p := New("")
	p.Add(&auth.Auth{UID: "a"})
	p.Add(&auth.Auth{UID: "b"})
	p.SetCredits("a", 500, 0)
	p.SetCredits("b", 100, 0)
	legacy := map[string]int{}
	filtered := map[string]int{}
	for i := 0; i < 500; i++ {
		if acct := p.PickExcludingForRealm(nil, "", ""); acct != nil {
			legacy[acct.UID]++
		}
		if acct := p.PickExcludingForRealmFiltered(nil, "", "", PickFilter{}); acct != nil {
			filtered[acct.UID]++
		}
	}
	for _, uid := range []string{"a", "b"} {
		if legacy[uid] == 0 || filtered[uid] == 0 {
			t.Fatalf("zero-value filter changed selection: legacy=%v filtered=%v", legacy, filtered)
		}
	}
}

// 会话粘性路径也要认白名单：粘性只记 uid，不复核就会把白名单外的号一路钉住。
func TestPickByUIDForModelFilteredHonoursAllow(t *testing.T) {
	p := New("")
	p.Add(&auth.Auth{UID: "a"})
	p.Add(&auth.Auth{UID: "b"})
	if acct := p.PickByUIDForModelFiltered("a", "", PickFilter{Allow: uidSet("b")}); acct != nil {
		t.Fatalf("sticky pick=%v want nil (a not in key's binds)", acct)
	}
	if acct := p.PickByUIDForModelFiltered("b", "", PickFilter{Allow: uidSet("b")}); acct == nil || acct.UID != "b" {
		t.Fatalf("sticky pick=%v want b", acct)
	}
	// 独占排除同样生效：粘在别人独占的号上必须解绑回落。
	if acct := p.PickByUIDForModelFiltered("a", "", PickFilter{ExcludeClaimed: uidSet("a")}); acct != nil {
		t.Fatalf("sticky pick=%v want nil (a claimed by another key)", acct)
	}
}

// 兜底选号（全池该模型冷却时走的 pickEarliestExpiryLocked 路径）也要过滤：
// 这是最容易漏的一处——普通选号被过滤了，兜底却把独占号借出去，等于没做。
//
// 前提：兜底只在账号**有到期时间**时才可能选中（expiry 为零即跳过），所以这里给
// 两个号都装上到期积分，再用白名单把它逼到唯一候选或全空。
func TestPickFilterAppliesToExpiryFallback(t *testing.T) {
	withNoPickGap(t)
	p := New("")
	a := &auth.Auth{UID: "a"}
	b := &auth.Auth{UID: "b"}
	p.Add(a)
	p.Add(b)
	p.SetCredits("a", 999, 0)
	p.SetCredits("b", 10, 0)

	now := time.Now()
	// 兜底候选的准入条件是 entry.expiry(now) 非零（软/硬冷却或熔断的解除时刻），
	// 不是积分到期日；给两个号塞一个未来的软冷却解除时间即可让它们进入兜底候选
	// （兜底按「最早解除」挑，正是全池冷却时的真实形状）。
	p.mu.Lock()
	for _, uid := range []string{"a", "b"} {
		if e, ok := p.byUID[uid]; ok {
			e.until = now.Add(time.Hour)
			e.coolKind = CoolSoft
		}
	}
	p.mu.Unlock()

	if acct := p.pickEarliestExpiryLocked(nil, now, "", "", PickFilter{Allow: uidSet("b")}); acct == nil || acct.UID != "b" {
		t.Fatalf("fallback pick=%v want b (allow list must apply)", acct)
	}
	if acct := p.pickEarliestExpiryLocked(nil, now, "", "", PickFilter{Allow: uidSet("zzz")}); acct != nil {
		t.Fatalf("fallback pick=%v want nil (nothing in allow list)", acct)
	}
	if acct := p.pickEarliestExpiryLocked(nil, now, "", "", PickFilter{ExcludeClaimed: uidSet("a")}); acct == nil || acct.UID != "b" {
		t.Fatalf("fallback pick=%v want b (a is claimed)", acct)
	}
}
