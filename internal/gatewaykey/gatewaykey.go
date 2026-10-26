// Package gatewaykey 管理发给下游客户端的网关 API Key（下称「客户 Key」），并为每个
// Key 绑定可选的上游账号集合与积分额度。
//
// 与 internal/auth 的区别：auth 是**上游**（WorkBuddy）账号凭证，本包是**下游**
// 客户端拿到的那把 Bearer。进程里另有一把「主密钥」（config.api_key，面板自己在用、
// 也作为兜底流量口）；客户 Key 是有名字、可绑号、可限额的成员密钥，挂在 httpauth
// 的认证钩子上，与主密钥互不覆盖（主密钥始终有效——否则面板会把自己锁在门外）。
//
// 三件事各自的口径：
//
//   - 认证：明文 key 不落盘，只存 sha256（hex）。明文只在创建/重置那一次返回，
//     之后不可再取（只能重置——面板上「看一眼」的成本是换一把新 Key）。
//   - 独占：Binds 非空时，该 Key 的流量**只能**路由到这些账号；同时被绑定的账号从
//     「未绑定流量」（主密钥 / 未绑号的客户 Key）里剔除——这是「独占」的实质，
//     否则「绑定」只是给这把 Key 画了个圈，号照样被别人用。
//   - 额度：只累加上游**实测回报**的 usage.credit。拿不到 credit 的请求记 0，并把
//     次数记进 UnknownCredits（「未知不扣，但要看得见」）。从未观测到 credit 的 Key
//     不受上限约束——把「没测到」当成「没花钱」去拦，会把自己锁死。
//     LimitPeriod=day 按 CST 自然日滚动重置；=total 是累计总额，换日不清零。
//
// 持久化：data/gateway_keys.json（与 state/usage/request-logs 同目录），
// safefile.WriteKeep 原子替换 + .bak 兜底。并发：一把 RWMutex 保护整个快照，
// 读路径（选号取绑定额、判额）只做 map 命中与浅拷贝。
package gatewaykey

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/cst"
	"github.com/misakano7545/workbuddy2api-panel/internal/safefile"
)

// KeyPrefix 客户 Key 的明文前缀。刻意与上游账号凭证（ck_/pt_）和主密钥（sk-）
// 都不同：一眼看出「这是网关签发的下游 Key」，贴错地方时不至于被当成上游凭证
// 塞进 auths/ 目录。
const KeyPrefix = "gw-"

// 名称/备注长度上限（按 rune 计）；备注可为空。
const (
	nameMaxLen   = 48
	remarkMaxLen = 200
)

// LimitPeriod 额度周期。
type LimitPeriod string

const (
	// PeriodNone 不限额（积分照常记账，只做展示）。
	PeriodNone LimitPeriod = ""
	// PeriodDay 每个 CST 自然日重置（与上游结算日、网关预算闸同口径）。
	PeriodDay LimitPeriod = "day"
	// PeriodTotal 累计总额，换日不清零，靠面板「重置额度」归零。
	PeriodTotal LimitPeriod = "total"
)

// Limits 单个客户 Key 的积分额度。
type Limits struct {
	// Period 周期；空 = 不限额。
	Period LimitPeriod `json:"period"`
	// Credits 上限（积分）。Period 非空时必须 > 0。
	Credits float64 `json:"credits"`
}

// Record 一个客户 Key 的落盘形态。对外接口另有 View（不含 hash + 带运行期字段）。
type Record struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Remark  string `json:"remark,omitempty"`
	KeyHash string `json:"key_hash"`
	// KeyHint 明文尾部 4 位，供列表辨认「是哪把 Key」。
	KeyHint string `json:"key_hint"`
	// KeyPlain 明文存档：面板「查看」随时回显用。认证仍走 KeyHash（sha256），
	// 明文只用于管理面展示，不参与任何运行期比对。旧数据没有该字段 = 无法回显，
	// 轮换一次后即有存档。
	KeyPlain string `json:"key_plain,omitempty"`
	// Binds 绑定的上游账号 uid 集合。非空 = 独占：本 Key 只用这些号，这些号也只服务
	// 绑定了它们的 Key。
	Binds []string `json:"binds,omitempty"`
	// BindsAll 标记「全池放行」。只在「显式勾了全部账号」或「创建时池为空、先按全池
	// 放行」时置位；仅影响面板文案，运行期语义仍是白名单。
	BindsAll bool   `json:"binds_all,omitempty"`
	Limits   Limits `json:"limits"`
	// Disabled 停用：认证仍能识别（回 401 且说明已停用，而不是「不认识这把 Key」），
	// 但不放行任何流量、不再累加额度。
	Disabled  bool      `json:"disabled,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// Requests / CreditsObserved 跨周期累计的头寸（额度游标本身不落盘，见 usageState）。
	Requests        int64   `json:"requests"`
	CreditsObserved float64 `json:"credits_observed"`
}

// View 对外（面板）视图：不含 hash，带运行期额度状态。
type View struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Remark   string   `json:"remark"`
	KeyHint  string   `json:"key_hint"`
	Key      string   `json:"key,omitempty"` // 明文（有存档时回显；旧数据无存档为空）
	Binds    []string `json:"binds"`
	BindsAll bool     `json:"binds_all"`
	Limits   Limits   `json:"limits"`
	// Used 当前周期已用积分（实测口径）；Day 是当日游标的日键（total 周期下为空）。
	Used float64 `json:"used"`
	Day  string  `json:"day,omitempty"`
	// Remaining 剩余额度；不限额为 -1（前端据此不展示进度条）。
	Remaining float64 `json:"remaining"`
	// Requests 累计请求数（跨周期）；UnknownCredits 是没拿到 usage.credit 的次数。
	Requests       int64     `json:"requests"`
	UnknownCredits int64     `json:"unknown_credits"`
	Disabled       bool      `json:"disabled"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	LastUsedAt     time.Time `json:"last_used_at"`
	// Exhausted 当前周期已到上限（仅 Period 非空时有意义）。
	Exhausted bool `json:"exhausted"`
}

// usageState 运行期额度游标。不可落盘也不该落盘：它是记账，不是配置；重启后从 0
// 计量、换日自动滚动。硬额度想跨重启精确累积时用 PeriodTotal + 面板「重置额度」，
// 语义比「重启后突然又有一整份额度」更容易解释。
type usageState struct {
	day      string
	used     float64
	requests int64
	unknown  int64
	lastUsed time.Time
}

// Store 客户 Key 集合。零值不可用，用 Open 构造。
type Store struct {
	path string

	mu    sync.RWMutex
	recs  []Record
	byID  map[string]int
	byKey map[string]int // hex(sha256(明文)) → recs 下标
	// claims 被任意 Key 绑定的 uid 并集（选号侧 O(1) 判「这个号是否专属」）。
	claims map[string]struct{}
	usage  map[string]*usageState

	warned bool // 「额度已用尽」日志去重（恢复后允许再报一次）
}

// Open 载入 Store。path 不存在 = 空集合（不是错误）；文件损坏时 safefile.Read 回退
// .bak，两边都坏才报错——与 auth.LoadDir 同口径：说清坏在哪，绝不静默清空。
func Open(path string) (*Store, error) {
	s := &Store{
		path:   path,
		byID:   map[string]int{},
		byKey:  map[string]int{},
		claims: map[string]struct{}{},
		usage:  map[string]*usageState{},
	}
	raw, err := safefile.Read(path, nil)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return s, nil
		}
		return nil, fmt.Errorf("client keys: %w", err)
	}
	var recs []Record
	if err := json.Unmarshal(raw, &recs); err != nil {
		return nil, fmt.Errorf("client keys %s: %w", path, err)
	}
	for _, r := range recs {
		if strings.TrimSpace(r.ID) == "" || strings.TrimSpace(r.KeyHash) == "" {
			log.Printf("WARN: client keys: 跳过缺少 id/key_hash 的条目 %q", r.Name)
			continue
		}
		s.recs = append(s.recs, r)
	}
	s.reindexLocked()
	return s, nil
}

// Path 返回落盘路径（面板展示用）。
func (s *Store) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}

// Len 返回客户 Key 数量。
func (s *Store) Len() int {
	if s == nil {
		return 0
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.recs)
}

// reindexLocked 重建索引（载入与每次写操作后调用，调用方需持写锁）。
func (s *Store) reindexLocked() {
	s.byID = make(map[string]int, len(s.recs))
	s.byKey = make(map[string]int, len(s.recs))
	s.claims = make(map[string]struct{})
	for i := range s.recs {
		r := &s.recs[i]
		s.byID[r.ID] = i
		s.byKey[r.KeyHash] = i
		for _, uid := range r.Binds {
			s.claims[uid] = struct{}{}
		}
	}
}

// hashKey 明文 → 落盘摘要 hex(sha256)。与 httpauth 的 digest 同算法（那一侧比的是
// 原始 32 字节，这里转 hex 只为可读与建索引）。
func hashKey(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// keyHint 明文尾部 4 位（不足 4 位则原样），列表里用来区分不同的 Key。
func keyHint(plain string) string {
	if len(plain) <= 4 {
		return plain
	}
	return plain[len(plain)-4:]
}

// Authenticate 用明文 key 认证。返回 ErrInvalid（不认识）或 ErrDisabled（已停用）；
// 成功时返回只读快照 *Entry——请求路径全程只用它，不再回查 Store。
func (s *Store) Authenticate(plain string) (*Entry, error) {
	if s == nil || strings.TrimSpace(plain) == "" {
		return nil, ErrInvalid
	}
	sum := sha256.Sum256([]byte(plain))
	hexSum := hex.EncodeToString(sum[:])

	s.mu.RLock()
	idx, ok := s.byKey[hexSum]
	if !ok || idx >= len(s.recs) {
		s.mu.RUnlock()
		// 未命中也要走一次定长比较，保持耗时形状一致（与 httpauth 同理由）。
		subtle.ConstantTimeCompare(sum[:], sum[:])
		return nil, ErrInvalid
	}
	r := s.recs[idx]
	s.mu.RUnlock()

	// 双保险：索引命中也再比一次摘要（防索引被写坏时放行错误 key）。
	want, _ := hex.DecodeString(r.KeyHash)
	if len(want) != len(sum) || subtle.ConstantTimeCompare(want, sum[:]) != 1 {
		return nil, ErrInvalid
	}
	if r.Disabled {
		return &Entry{id: r.ID, name: r.Name, disabled: true}, ErrDisabled
	}
	e := &Entry{
		id:     r.ID,
		name:   r.Name,
		binds:  make([]string, len(r.Binds)),
		limits: r.Limits,
	}
	copy(e.binds, r.Binds)

	s.mu.RLock()
	if st := s.usage[r.ID]; st != nil {
		e.day, e.used, e.requests, e.unknown = st.day, st.used, st.requests, st.unknown
	}
	s.mu.RUnlock()
	e.roll(time.Now())
	return e, nil
}

var (
	// ErrInvalid key 不存在 / 为空 / 摘要不匹配。
	ErrInvalid = errors.New("unknown client key")
	// ErrDisabled key 已被停用。
	ErrDisabled = errors.New("client key disabled")
	// ErrNotFound 管理侧指定的 Key id 不存在（与「明文不认识」的 ErrInvalid 区分：
	// 面板回 404 还是 400，取决于「这把 Key 不在了」还是「你传的东西不合法」）。
	ErrNotFound = errors.New("客户 Key 不存在")
)

// Entry 一次认证通过后的只读快照（不含明文）。请求路径全程只用它。
type Entry struct {
	id       string
	name     string
	binds    []string
	limits   Limits
	used     float64
	day      string
	requests int64
	unknown  int64
	disabled bool
}

// ID / Name 供日志与归档标注调用方身份（空安全：nil Entry 返回空串）。
func (e *Entry) ID() string {
	if e == nil {
		return ""
	}
	return e.id
}

// Name 名称。
func (e *Entry) Name() string {
	if e == nil {
		return ""
	}
	return e.name
}

// Binds 绑定的账号 uid **副本**（空 = 不绑定，按全池共享）。
// 返回副本：调用方（handler 传给选号）不得改动 Store 内部状态。
func (e *Entry) Binds() []string {
	if e == nil || len(e.binds) == 0 {
		return nil
	}
	out := make([]string, len(e.binds))
	copy(out, e.binds)
	return out
}

// Bound 报告是否绑定了账号（= 该 Key 是独占型）。
func (e *Entry) Bound() bool { return e != nil && len(e.binds) > 0 }

// Limits 当前额度配置（值类型副本）。
func (e *Entry) Limits() Limits {
	if e == nil {
		return Limits{}
	}
	return e.limits
}

// Used 当前周期已用积分（快照时刻）。
func (e *Entry) Used() float64 {
	if e == nil {
		return 0
	}
	return e.used
}

// Roll 把日周期游标滚到今天；返回是否发生了重置。供调用方在长连接前后的判额
// 路径上刷新，避免拿昨天的 used 去拦今天的请求。
func (e *Entry) Roll(now time.Time) bool { return e.roll(now) }

func (e *Entry) roll(now time.Time) bool {
	if e == nil || e.limits.Period != PeriodDay {
		return false
	}
	if day := cst.Day(now); day != e.day {
		e.day = day
		e.used = 0
		return true
	}
	return false
}

// Exhausted 当前周期已达上限（Period 为空恒 false）。
func (e *Entry) Exhausted() bool {
	if e == nil || e.limits.Period == PeriodNone || e.limits.Credits <= 0 {
		return false
	}
	// 浮点累加留一点容差：多段 usage 累加可能得到 9.999999999999。
	return e.used+e.limits.Credits*1e-12 >= e.limits.Credits
}

// Remaining 剩余额度；不限额返回 -1（调用方据此不展示/不判）。
func (e *Entry) Remaining() float64 {
	if e == nil || e.limits.Period == PeriodNone || e.limits.Credits <= 0 {
		return -1
	}
	rem := e.limits.Credits - e.used
	if rem < 0 {
		return 0
	}
	return rem
}

// LimitText 额度的一句话描述（错误信息与日志共用，避免两处各拼一份）。
// 例：「本周期剩余 3.20 / 10.00 积分（day 周期，北京时间 0 点重置）」。
func (e *Entry) LimitText() string {
	if e == nil || e.limits.Period == PeriodNone || e.limits.Credits <= 0 {
		return ""
	}
	cycle := "累计总额（需手动重置）"
	if e.limits.Period == PeriodDay {
		cycle = "每日额度（北京时间 0 点重置）"
	}
	return fmt.Sprintf("本周期剩余 %.2f / %.2f 积分（%s）", e.Remaining(), e.limits.Credits, cycle)
}

// Claimed 返回被任意客户 Key 绑定的 uid 并集（副本）。选号侧在候选遍历前取一次，
// 循环里只做 map 命中——不逐号回查 Store（那把锁会让选号与面板保存互相拖慢）。
func (s *Store) Claimed() map[string]struct{} {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.claims) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(s.claims))
	for uid := range s.claims {
		out[uid] = struct{}{}
	}
	return out
}

// Record 记一次已完成的请求：requests++，有实测 credit 才计入额度。
// observed=false（上游没给 usage.credit）只计 UnknownCredits，**不计额度**。
//
// 额度游标按 id 维护（认证快照里的 used 只用于判额，真正累加在 Store 里，
// 因为一次请求可能拆多条 usage 记录）。
func (s *Store) Record(id string, credit float64, observed bool) {
	if s == nil || id == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, ok := s.byID[id]
	if !ok || idx >= len(s.recs) {
		return
	}
	r := &s.recs[idx]
	st := s.usage[id]
	if st == nil {
		st = &usageState{day: cst.Day(time.Now())}
		s.usage[id] = st
	}
	s.rollLocked(r, st)
	st.requests++
	st.lastUsed = time.Now()
	r.Requests++
	if !observed {
		st.unknown++
	} else if credit > 0 {
		st.used += credit
		r.CreditsObserved += credit
	}
	// 用尽/恢复只各打一行：这是「客户 Key 停了」的第一手线索，又不能每次请求刷屏。
	exhausted := r.Limits.Period != PeriodNone && r.Limits.Credits > 0 && st.used+1e-12 >= r.Limits.Credits
	switch {
	case exhausted && !s.warned:
		s.warned = true
		log.Printf("WARN: [gatewaykey] 客户 Key %q(%s) 额度已用尽 %.2f/%.2f（%s 周期）——后续请求将 429，调高上限或重置额度后自动恢复",
			r.Name, r.ID, st.used, r.Limits.Credits, r.Limits.Period)
	case !exhausted && s.warned:
		s.warned = false
	}
}

// rollLocked 滚动单个 Key 的日游标（调用方需持写锁）。
func (s *Store) rollLocked(r *Record, st *usageState) {
	if r.Limits.Period != PeriodDay {
		return
	}
	if day := cst.Day(time.Now()); day != st.day {
		st.day = day
		st.used = 0
	}
}

// —— 面板 CRUD ——

// Input 创建/更新入参。指针字段 = 「本次提供了该字段」（更新时只改提供的项）；
// Create 同样只认提供的项，其余取零值语义。
type Input struct {
	Name     *string   `json:"name"`
	Remark   *string   `json:"remark"`
	Binds    *[]string `json:"binds"`
	BindsAll *bool     `json:"binds_all"`
	Limits   *Limits   `json:"limits"`
	Disabled *bool     `json:"disabled"`
	// Key 自定义明文（可选）：Create/RotateTo 时若非空则用它而非随机生成。
	// 留空 = 沿用随机 32 字节；给值则做 validateKey 校验后落 sha256。
	Key *string `json:"key,omitempty"`
}

// validateKey 校验自定义明文：非空、不含空白、长度在 [8, 128] 字节之间。
// 不强求 gw- 前缀——有些下游要贴自己的固定 Key 值；但留出提示由调用方决定。
func validateKey(plain string) error {
	p := strings.TrimSpace(plain)
	if p == "" {
		return errors.New("自定义 Key 不能为空")
	}
	if strings.ContainsAny(p, " \t\r\n") {
		return errors.New("自定义 Key 不能包含空白字符")
	}
	if n := len(p); n < 8 || n > 128 {
		return fmt.Errorf("自定义 Key 长度需在 8–128 字节之间（当前 %d）", n)
	}
	return nil
}

// Create 新建客户 Key，返回明文（**仅此一次**）与视图。
//
// 默认 32 字节 crypto/rand（256 bit）+ base64url 无填充，前缀 gw-：暴力枚举不可行，
// 长度与主流网关 Key 相当。in.Key 非空时改用调用方提供的自定义明文（validateKey 校验）。
func (s *Store) Create(in Input) (string, View, error) {
	plain := ""
	if in.Key != nil && strings.TrimSpace(*in.Key) != "" {
		if err := validateKey(*in.Key); err != nil {
			return "", View{}, err
		}
		plain = strings.TrimSpace(*in.Key)
	} else {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return "", View{}, fmt.Errorf("generate key: %w", err)
		}
		plain = KeyPrefix + base64.RawURLEncoding.EncodeToString(raw)
	}

	name := ""
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
	}
	if err := validateName(name); err != nil {
		return "", View{}, err
	}
	remark, err := validateRemark(in.Remark)
	if err != nil {
		return "", View{}, err
	}
	binds := []string{}
	if in.Binds != nil {
		binds = normalizeBinds(*in.Binds)
	}
	limits := Limits{}
	if in.Limits != nil {
		if limits, err = validateLimits(*in.Limits); err != nil {
			return "", View{}, err
		}
	}
	dis := in.Disabled != nil && *in.Disabled
	all := (in.BindsAll != nil && *in.BindsAll) && len(binds) == 0
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	// 自定义明文可能与已有 Key 冲突：hash 撞了意味着两把 Key 认同一段明文，
	// 认证会串号（这把的额度记到那把头上）。随机生成的 256bit 碰撞概率可忽略，
	// 但自定义明文必须显式拦。
	if _, dup := s.byKey[hashKey(plain)]; dup {
		return "", View{}, errors.New("自定义 Key 与已有客户 Key 重复，请换一个")
	}
	r := Record{
		ID:        newID(now, len(s.recs)),
		Name:      name,
		Remark:    remark,
		KeyHash:   hashKey(plain),
		KeyHint:   keyHint(plain),
		KeyPlain:  plain,
		Binds:     binds,
		BindsAll:  all,
		Limits:    limits,
		Disabled:  dis,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.recs = append(s.recs, r)
	s.reindexLocked()
	if err := s.saveLocked(); err != nil {
		// 落盘失败要回滚内存，否则面板显示「创建成功」而重启后 Key 消失——
		// 那是最难查的一类「怎么昨天还好好的」。
		s.recs = s.recs[:len(s.recs)-1]
		s.reindexLocked()
		return "", View{}, fmt.Errorf("保存客户 Key 失败: %w", err)
	}
	return plain, s.viewLocked(&s.recs[len(s.recs)-1]), nil
}

// Update 更新一个 Key 的配置（名称/备注/绑定/额度/停用）。未提供的字段不动。
// 返回更新后的视图。改额度周期时重置本周期游标（换周期还沿用旧 used 会立刻误判）。
func (s *Store) Update(id string, in Input) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, ok := s.byID[id]
	if !ok || idx >= len(s.recs) {
		return View{}, ErrNotFound
	}
	r := &s.recs[idx]
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if err := validateName(name); err != nil {
			return View{}, err
		}
		r.Name = name
	}
	if in.Remark != nil {
		remark, err := validateRemark(in.Remark)
		if err != nil {
			return View{}, err
		}
		r.Remark = remark
	}
	if in.Binds != nil {
		r.Binds = normalizeBinds(*in.Binds)
		r.BindsAll = in.BindsAll != nil && *in.BindsAll && len(r.Binds) == 0
	} else if in.BindsAll != nil {
		r.BindsAll = *in.BindsAll && len(r.Binds) == 0
	}
	if in.Limits != nil {
		limits, err := validateLimits(*in.Limits)
		if err != nil {
			return View{}, err
		}
		if limits != r.Limits {
			// 周期或上限变化 → 本周期游标归零（改名/换周期后「立刻超限」是纯坑）。
			st := s.usage[id]
			if st == nil {
				st = &usageState{}
				s.usage[id] = st
			}
			st.used = 0
			st.day = cst.Day(time.Now())
		}
		r.Limits = limits
	}
	if in.Disabled != nil {
		r.Disabled = *in.Disabled
	}
	r.UpdatedAt = time.Now()
	prev := *r
	s.reindexLocked()
	if err := s.saveLocked(); err != nil {
		// 与 Create 同理：落盘失败回滚，内存与磁盘不允许分叉。
		s.recs[idx] = prev
		s.reindexLocked()
		return View{}, fmt.Errorf("保存客户 Key 失败: %w", err)
	}
	return s.viewLocked(r), nil
}

// Delete 删除一个 Key。返回是否真的删掉了（不存在的 id 返回 false，由面板回 404）。
func (s *Store) Delete(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, ok := s.byID[id]
	if !ok || idx >= len(s.recs) {
		return false, nil
	}
	prev := make([]Record, len(s.recs))
	copy(prev, s.recs)
	s.recs = append(s.recs[:idx:idx], s.recs[idx+1:]...)
	delete(s.usage, id)
	s.reindexLocked()
	if err := s.saveLocked(); err != nil {
		s.recs = prev
		s.reindexLocked()
		return false, fmt.Errorf("保存客户 Key 失败: %w", err)
	}
	return true, nil
}

// ResetUsage 把某个 Key 的额度游标归零（total 周期「充值」、或提前开新一天）。
// 保留累计请求数与历史观测值——它们描述的是「发生过什么」，不是额度。
func (s *Store) ResetUsage(id string) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, ok := s.byID[id]
	if !ok || idx >= len(s.recs) {
		return View{}, ErrNotFound
	}
	st := s.usage[id]
	if st == nil {
		st = &usageState{}
		s.usage[id] = st
	}
	st.used = 0
	st.day = cst.Day(time.Now())
	s.warned = false
	return s.viewLocked(&s.recs[idx]), nil
}

// Rotate 轮换明文：生成新 key、替换摘要与 hint，旧明文立即失效。
// 返回新明文（仅此一次）+ 视图。
func (s *Store) Rotate(id string) (string, View, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", View{}, fmt.Errorf("generate key: %w", err)
	}
	return s.rotateWithPlain(id, KeyPrefix+base64.RawURLEncoding.EncodeToString(raw))
}

// RotateTo 轮换到调用方指定的自定义明文（旧明文立即失效）。
// customKey 走 validateKey + 唯一性校验，与 Create 的自定义口径一致。
func (s *Store) RotateTo(id, customKey string) (string, View, error) {
	if err := validateKey(customKey); err != nil {
		return "", View{}, err
	}
	return s.rotateWithPlain(id, strings.TrimSpace(customKey))
}

func (s *Store) rotateWithPlain(id, plain string) (string, View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, ok := s.byID[id]
	if !ok || idx >= len(s.recs) {
		return "", View{}, ErrNotFound
	}
	if _, dup := s.byKey[hashKey(plain)]; dup && s.recs[idx].KeyHash != hashKey(plain) {
		return "", View{}, errors.New("自定义 Key 与已有客户 Key 重复，请换一个")
	}
	r := &s.recs[idx]
	prevHash, prevHint, prevPlain, prevUpdated := r.KeyHash, r.KeyHint, r.KeyPlain, r.UpdatedAt
	r.KeyHash = hashKey(plain)
	r.KeyHint = keyHint(plain)
	r.KeyPlain = plain
	r.UpdatedAt = time.Now()
	s.reindexLocked()
	if err := s.saveLocked(); err != nil {
		r.KeyHash, r.KeyHint, r.KeyPlain, r.UpdatedAt = prevHash, prevHint, prevPlain, prevUpdated
		s.reindexLocked()
		return "", View{}, fmt.Errorf("保存客户 Key 失败: %w", err)
	}
	return plain, s.viewLocked(r), nil
}

// List 返回全部 Key 的视图（创建序 + 当前额度游标）。
func (s *Store) List() []View {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]View, 0, len(s.recs))
	for i := range s.recs {
		out = append(out, s.viewLocked(&s.recs[i]))
	}
	return out
}

// Get 返回单个 Key 的视图。
func (s *Store) Get(id string) (View, bool) {
	if s == nil {
		return View{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idx, ok := s.byID[id]
	if !ok || idx >= len(s.recs) {
		return View{}, false
	}
	return s.viewLocked(&s.recs[idx]), true
}

// viewLocked 由 Record + 当前游标构造视图（调用方需持锁，写锁优先——它会滚动日游标）。
func (s *Store) viewLocked(r *Record) View {
	st := s.usage[r.ID]
	if st == nil {
		st = &usageState{day: cst.Day(time.Now())}
		s.usage[r.ID] = st
	}
	s.rollLocked(r, st)
	v := View{
		ID:             r.ID,
		Name:           r.Name,
		Remark:         r.Remark,
		KeyHint:        r.KeyHint,
		Key:            r.KeyPlain,
		Binds:          append([]string{}, r.Binds...),
		BindsAll:       r.BindsAll,
		Limits:         r.Limits,
		Used:           st.used,
		Requests:       r.Requests,
		UnknownCredits: st.unknown,
		Disabled:       r.Disabled,
		CreatedAt:      r.CreatedAt,
		UpdatedAt:      r.UpdatedAt,
		LastUsedAt:     st.lastUsed,
		Remaining:      -1,
	}
	if r.Limits.Period == PeriodDay {
		v.Day = st.day
	}
	if r.Limits.Period != PeriodNone && r.Limits.Credits > 0 {
		v.Remaining = r.Limits.Credits - st.used
		if v.Remaining < 0 {
			v.Remaining = 0
		}
		v.Exhausted = st.used+r.Limits.Credits*1e-12 >= r.Limits.Credits
	}
	return v
}

// saveLocked 原子落盘当前集合（调用方需持写锁）。目录不存在则创建。
func (s *Store) saveLocked() error {
	if s.path == "" {
		return errors.New("client keys: 未配置存储路径")
	}
	raw, err := json.MarshalIndent(s.recs, "", "  ")
	if err != nil {
		return err
	}
	if dir := filepath.Dir(s.path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	// 0600：文件里是 Key 摘要（不是明文），但绑定额 + 额度同属管理面数据，
	// 与 auth 凭证同权限，不给同机其他用户读。
	return safefile.WriteKeep(s.path, raw, 0o600)
}

// —— 校验 ——

// validateName 名称：非空、≤nameMaxLen rune、不含换行（日志与表格一行一条）。
func validateName(name string) error {
	if name == "" {
		return errors.New("名称不能为空")
	}
	if strings.ContainsAny(name, "\r\n") {
		return errors.New("名称不能包含换行")
	}
	if n := len([]rune(name)); n > nameMaxLen {
		return fmt.Errorf("名称过长（%d > %d 字）", n, nameMaxLen)
	}
	return nil
}

// validateRemark 备注：可空，≤remarkMaxLen rune，不含换行。
func validateRemark(in *string) (string, error) {
	if in == nil {
		return "", nil
	}
	remark := strings.TrimSpace(*in)
	if strings.ContainsAny(remark, "\r\n") {
		return "", errors.New("备注不能包含换行")
	}
	if n := len([]rune(remark)); n > remarkMaxLen {
		return "", fmt.Errorf("备注过长（%d > %d 字）", n, remarkMaxLen)
	}
	return remark, nil
}

// validateLimits 额度校验：周期为空 = 不限额，此时 credits 归零；周期非空必须
// credits > 0——「设了周期但上限 0」是配置错误，不是「不限额」的另一种写法
// （后者容易让新 Key 一出生就用尽，现象是「刚建好就 429」）。
func validateLimits(l Limits) (Limits, error) {
	switch l.Period {
	case PeriodNone:
		return Limits{}, nil
	case PeriodDay, PeriodTotal:
	default:
		return Limits{}, fmt.Errorf("额度周期 %q 非法（留空 = 不限额 / day / total）", l.Period)
	}
	if l.Credits <= 0 {
		return Limits{}, errors.New("设了额度周期就必须给出大于 0 的积分上限（不限额请把周期留空）")
	}
	if l.Credits > 1e9 {
		return Limits{}, errors.New("积分上限过大（> 1e9）")
	}
	return l, nil
}

// normalizeBinds 去空白、去重、字典序稳定排序（落盘与面板展示都不随点击顺序漂移）。
func normalizeBinds(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, uid := range in {
		uid = strings.TrimSpace(uid)
		if uid == "" {
			continue
		}
		if _, dup := seen[uid]; dup {
			continue
		}
		seen[uid] = struct{}{}
		out = append(out, uid)
	}
	sort.Strings(out)
	return out
}

// newID 生成短 id（面板 URL/表格用）：时间戳 + 序号 + 4 字节随机，够短也够唯一。
// 不用明文 key 的任何片段，避免「id 泄露明文」这类无心之失。
func newID(now time.Time, seq int) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("ck_%s_%02d_%s", now.Format("20060102150405"), seq%100, hex.EncodeToString(b))
}
