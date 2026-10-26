// Package httpauth 网关与面板共用的 Bearer 鉴权原语。
//
// 单独成包的原因：server（/v1/*、/status）与 panel（/panel/api/*）两处鉴权
// 必须完全同口径——此前各自复制了一份"字符串直接比较"的实现，既容易漂移，
// 又都带计时侧信道。统一到这里后，口径只有一份，且天然常量时间比较。
//
// 本包还承载「身份」的最小抽象（Identity / Verifier / AcceptBearer）：网关在认证
// 之后要知道「这条请求是哪把客户 Key 的、绑了哪些号、额度还剩多少」，但认证原语
// 不该 import 上层包。用一个带回调的接口把「认出来是谁」与「怎么用这个身份」解耦：
// httpauth 只负责拦，server 负责解释。
package httpauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

// bearerPrefix 认证方案前缀（大小写敏感，与 HTTP 规范及既有实现一致）。
const bearerPrefix = "Bearer "

// VerifyBearer 校验请求头是否携带正确的 Bearer 密钥。
//
// key 为空表示"未启用鉴权"，恒返回 true（调用方据此放行）。
// 比较用 SHA-256 摘要 + subtle.ConstantTimeCompare：
//   - 常量时间，不因前缀匹配长度而泄露信息；
//   - 先摘要再比较，长度差异被吸收进摘要（不会因长度不同提前返回）；
//   - 摘要本身不可逆，即便有侧信道也拿不到密钥原文。
func VerifyBearer(r *http.Request, key string) bool {
	if key == "" {
		return true
	}
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, bearerPrefix) {
		// 缺头/方案不对：仍走一次摘要比较，保持耗时形状一致。
		subtle.ConstantTimeCompare(digest(""), digest(key))
		return false
	}
	tok := authz[len(bearerPrefix):]
	return subtle.ConstantTimeCompare(digest(tok), digest(key)) == 1
}

// digest 返回 s 的 SHA-256（定长 32 字节，供常量时间比较）。
func digest(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// ErrKeyDisabled 客户 Key 存在但已停用（区别于「不认识这把 Key」）。
var ErrKeyDisabled = errors.New("client key disabled")

// BearerToken 提取请求头里的 Bearer 令牌（前缀缺失或为空时返回空串）。
// 客户 Key 的摘要比对在上层做，这里只负责把明文取出来。
func BearerToken(r *http.Request) string {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, bearerPrefix) {
		return ""
	}
	return authz[len(bearerPrefix):]
}

// Identity 一次认证通过的调用方身份。零值 = 主密钥（未开通客户 Key 的旧部署）。
type Identity struct {
	// ID 客户 Key 的 id；空 = 主密钥（主密钥不是客户 Key，日志里也不该冒充成一把 Key）。
	ID string
	// Name 客户 Key 名称（日志/归档展示用；空 = 未命名）。
	Name string
	// Binds 绑定的上游账号 uid（空 = 不绑定，按全池共享）。
	Binds []string
	// Disabled 已停用（认证失败时用来区分「停用」与「不认识」）。
	Disabled bool
	// Remain 剩余积分额度；< 0 = 不限额（由上层额度实现填充，httpauth 只透传）。
	Remain float64
	// Exhausted 当前周期已用尽。
	Exhausted bool
	// LimitLabel 额度的一句话描述（错误信息用，避免上层两处各拼一份）。
	LimitLabel string
}

// KeyID 返回「日志用」的调用方标识：客户 Key 显示 id，主密钥返回空串。
func (i Identity) KeyID() string {
	if i.Disabled {
		return ""
	}
	return i.ID
}

// Verifier 客户 Key 校验回调：明文 → (身份, 是否有效)。
// 无效时仍会返回带 Disabled 标记的身份，供 AcceptBearer 区分停用。
type Verifier func(plain string) (Identity, bool)

// AcceptBearer 组合校验「主密钥 + 客户 Key」。
//
// 顺序与语义：
//  1. 主密钥 **始终有效**（即便配置了客户 Key）——面板自己在用，收回主密钥等于把
//     自己锁在门外；它也是「未绑定流量」的兜底口。
//  2. 否则交给 verify（nil = 未开通客户 Key，直接拒绝）。
//
// 返回 (放行, 身份, 错误)；不放行时 err 可能为 ErrKeyDisabled。
func AcceptBearer(r *http.Request, master string, verify Verifier) (bool, Identity, error) {
	if VerifyBearer(r, master) {
		// 注意：主密钥为空时 VerifyBearer 恒 true（未启用鉴权），此时身份也确实
		// 是「主密钥」——语义一致，不需要特别分支。
		return true, Identity{Remain: -1}, nil
	}
	if verify == nil {
		return false, Identity{}, nil
	}
	tok := BearerToken(r)
	if tok == "" {
		return false, Identity{}, nil
	}
	id, ok := verify(tok)
	if !ok {
		if id.Disabled {
			return false, id, ErrKeyDisabled
		}
		return false, Identity{}, nil
	}
	return true, id, nil
}
