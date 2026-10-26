// clientkey.go 客户 API Key 在网关侧的接线：认证落身份、请求级账号范围、额度闸与记账。
//
// 分工：
//   - internal/gatewaykey 是存储与口径（认证摘要、绑定额、额度游标）；
//   - 本文件把「这条请求是谁的」放进 context，并把该身份的约束翻译成选号过滤器
//     （pool.PickFilter）与响应头/错误码。
//
// 三条硬语义（与 gatewaykey 包文档一致，改这里之前先读那里）：
//  1. 主密钥始终有效，身份为空——它不是客户 Key，不限额、不受绑定约束。
//  2. 绑定型 Key 只能用绑定的号；被绑定的号也不再服务未绑定流量（独占）。
//  3. 额度只吃实测 usage.credit；没拿到就记「未知」但不扣，未知 ≠ 0 花费。
package server

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/gatewaykey"
	"github.com/misakano7545/workbuddy2api-panel/internal/httpauth"
	"github.com/misakano7545/workbuddy2api-panel/internal/pool"
)

// 本文件依赖 Handler.cfg.ClientKeys / （可选）UsageArchiveKey：
//   - ClientKeys 非 nil 且 config client_keys.enabled=true 时启用客户 Key 认证；
//   - 关闭时 authorize 退化为旧的「只认主密钥」，其余路径零开销。

// clientKeyCtxKey context 键（未导出结构体，杜绝跨包碰撞）。
type clientKeyCtxKey struct{}

// clientKeyIdentity 请求级身份快照：认证时取出，请求结束记账时回写额度。
type clientKeyIdentity struct {
	entry *gatewaykey.Entry
}

// withIdentity 把客户 Key 身份放进请求 context。
func withIdentity(r *http.Request, e *gatewaykey.Entry) *http.Request {
	if e == nil {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), clientKeyCtxKey{}, &clientKeyIdentity{entry: e}))
}

// identityFrom 取请求的客户 Key 身份（nil = 主密钥 / 未启用客户 Key）。
func identityFrom(r *http.Request) *clientKeyIdentity {
	if r == nil {
		return nil
	}
	v, _ := r.Context().Value(clientKeyCtxKey{}).(*clientKeyIdentity)
	return v
}

// ClientKeyIdentity 对外（日志/归档）只看这几项：是哪把 Key、叫什么、有没有限额。
// 主密钥返回空串——归档里不该把主密钥伪装成一把客户 Key。
func clientKeyLabel(r *http.Request) string {
	id := identityFrom(r)
	if id == nil || id.entry == nil {
		return ""
	}
	name := id.entry.Name()
	if name == "" {
		return id.entry.ID()
	}
	return name
}

// clientKeyVerifier 构造 httpauth.Verifier：把 gatewaykey.Store 的结果翻成 Identity。
// 返回 nil 表示未启用客户 Key（config client_keys.enabled=false 或没有 store）。
func (h *Handler) clientKeyVerifier() httpauth.Verifier {
	if h.cfg.ClientKeys == nil || !h.loadLive().ClientKeysEnabled {
		return nil
	}
	store := h.cfg.ClientKeys
	return func(plain string) (httpauth.Identity, bool) {
		e, err := store.Authenticate(plain)
		if err != nil {
			if e != nil && e.Limits().Period != gatewaykey.PeriodNone {
				// 停用的 Key 也把额度信息带出去，方便调用方回「已停用（额度 x/y）」。
				return httpauth.Identity{
					ID: e.ID(), Name: e.Name(), Disabled: true,
					Remain: e.Remaining(), Exhausted: e.Exhausted(), LimitLabel: e.LimitText(),
				}, false
			}
			return httpauth.Identity{Disabled: e != nil}, false
		}
		return httpauth.Identity{
			ID:         e.ID(),
			Name:       e.Name(),
			Binds:      e.Binds(),
			Remain:     e.Remaining(),
			Exhausted:  e.Exhausted(),
			LimitLabel: e.LimitText(),
		}, true
	}
}

// authorizedClient 解析请求的调用方身份（不判额度，只判「能不能进」）。
//
// 与旧 withAuth 的差别只有一处：主密钥之外，客户 Key 也放行——但两者都要走
// httpauth 的常量时间比较。返回 (是否放行, 原因)：原因非空时由调用方按自身协议
// 形状回 401/429，避免本函数同时操心两套错误格式。
func (h *Handler) authorizedClient(r *http.Request) (*http.Request, string) {
	ok, id, err := httpauth.AcceptBearer(r, h.loadLive().APIKey, h.clientKeyVerifier())
	if !ok {
		switch {
		case err == httpauth.ErrKeyDisabled:
			if id.LimitLabel != "" {
				return r, "client key disabled（" + id.LimitLabel + "）"
			}
			return r, "client key disabled"
		default:
			return r, "missing or invalid API key"
		}
	}
	if id.ID == "" {
		return r, "" // 主密钥：不受绑定，也不限额
	}
	// 客户 Key：重新认证一次拿 Entry（AcceptBearer 只回了 Identity，没有额度游标）。
	// 这次认证是内存查表，成本可忽略；换来的是「上下文里那份 Entry 与 Storage 同源」。
	e, aerr := h.cfg.ClientKeys.Authenticate(httpauth.BearerToken(r))
	if aerr != nil {
		return r, "missing or invalid API key"
	}
	return withIdentity(r, e), ""
}

// clientKeyExhausted 额度闸：返回 (是否拦, 提示)。主密钥/不限额的 Key 恒放行。
func (h *Handler) clientKeyExhausted(r *http.Request) (bool, string) {
	id := identityFrom(r)
	if id == nil || id.entry == nil {
		return false, ""
	}
	e := id.entry
	e.Roll(time.Now())
	if !e.Exhausted() {
		return false, ""
	}
	msg := "client key credit quota exhausted（" + e.LimitText() + "）；额度用尽后请求会被拒绝，调高上限或重置额度后自动恢复"
	return true, msg
}

// clientKeyFilter 把当前请求的账号范围翻译成选号过滤器。
//
// 三种情形：
//   - 主密钥 / 未启用客户 Key（filter 恒零值）：池行为与旧版完全一致；
//   - 绑定型 Key：Allow = 绑定的号（只从这些号里选）；
//   - 未绑定流量：ExcludeClaimed = 被任意 Key 绑定的号并集（这些号只服务其主人）。
//
// 落空的副作用只有一个：候选集变小甚至为空 → 回 503 并说明「绑定范围内暂无可用
// 账号」，不编造「号全挂了」。
func (h *Handler) clientKeyFilter(r *http.Request) pool.PickFilter {
	id := identityFrom(r)
	store := h.cfg.ClientKeys
	if id == nil || id.entry == nil || store == nil {
		return pool.PickFilter{}
	}
	if binds := id.entry.Binds(); len(binds) > 0 {
		allow := make(map[string]struct{}, len(binds))
		for _, uid := range binds {
			allow[uid] = struct{}{}
		}
		return pool.PickFilter{Allow: allow}
	}
	// 未绑定流量：避开所有被独占的号。Claimed() 在无绑定时返回 nil，零分配。
	return pool.PickFilter{ExcludeClaimed: store.Claimed()}
}

// clientKeyBoundDesc 绑定范围的简短描述（错误信息用）："已绑定 2 个账号"。
func (h *Handler) clientKeyBoundDesc(r *http.Request) string {
	id := identityFrom(r)
	if id == nil || id.entry == nil {
		return ""
	}
	n := len(id.entry.Binds())
	if n == 0 {
		return ""
	}
	return "该 Key 已绑定 " + itoa(n) + " 个账号，绑定范围内当前没有可用账号"
}

// recordClientKeyUsage 请求结束时把实测积分记到客户 Key 的额度上。
// observed=false（上游没给 usage.credit）只计未知次数，不扣额度。
func (h *Handler) recordClientKeyUsage(r *http.Request, credit float64, observed bool) {
	id := identityFrom(r)
	if id == nil || h.cfg.ClientKeys == nil {
		return
	}
	h.cfg.ClientKeys.Record(id.entry.ID(), credit, observed)
}

// itoa 整数转字符串（绑定数描述用）。
func itoa(n int) string { return strconv.Itoa(n) }

// formatFloat 额度数值的展示形态：保留两位小数（积分是小数，但没人关心第三位）。
func formatFloat(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }

// clientKeyQuotaHeaders 把剩余额度写进响应头（OpenAI 生态的常见做法，客户端可自行
// 展示/告警）。不限额或主密钥不写——出现该头即表示「这条请求来自一把限额 Key」。
func (h *Handler) clientKeyQuotaHeaders(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r)
	if id == nil || id.entry == nil {
		return
	}
	e := id.entry
	lim := e.Limits()
	if lim.Period == gatewaykey.PeriodNone || lim.Credits <= 0 {
		return
	}
	// Roll 后的快照可能是新一天的；Remaining 只依赖周期游标，认证时已滚动过。
	rem := e.Remaining()
	if rem < 0 {
		return
	}
	w.Header().Set("X-Client-Key", e.ID())
	w.Header().Set("X-Credit-Limit", formatFloat(lim.Credits))
	w.Header().Set("X-Credit-Remaining", formatFloat(rem))
	if lim.Period == gatewaykey.PeriodDay {
		w.Header().Set("X-Credit-Period", "day")
	} else {
		w.Header().Set("X-Credit-Period", "total")
	}
}
