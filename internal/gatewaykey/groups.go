package gatewaykey

// groups.go 客户 Key 分组：key 通过 Record.Group 归属一个分组，分组可设模型白名单。
//
// 语义（与 clientkey.go / server 侧拦截一致）：
//   - 分组是独立实体，存独立文件 gateway_groups.json（与 gateway_keys.json 同目录）。
//   - 每个分组有一个 id、name，以及一个模型白名单 Models（可为空）。
//   - key 归属分组后，该 key 只能调用其分组白名单内的模型；白名单为空 = 不限制。
//   - 分组删除时，归属它的 key 的 Group 字段悬空：认证侧视为「无分组」（全放行），
//     面板可再次给 key 指派分组。这里不做级联清理（key 文件与分组文件分离）。

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/safefile"
)

// GroupRecord 一个分组的落盘形态。
type GroupRecord struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Models 允许调用的模型白名单（裸名或带 realm 前缀的完整名）。空 = 不限制。
	Models    []string  `json:"models,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// GroupStore 分组集合。零值不可用，用 OpenGroups 构造。
type GroupStore struct {
	path string

	mu    sync.RWMutex
	recs  []GroupRecord
	byID  map[string]int
	byKey map[string]int // key id → recs 下标（别名，语义同 byID）
}

// OpenGroups 载入分组存储。path 不存在 = 空集合（不是错误）。
func OpenGroups(path string) (*GroupStore, error) {
	gs := &GroupStore{
		path:  path,
		byID:  map[string]int{},
		byKey: map[string]int{},
	}
	raw, err := safefile.Read(path, nil)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return gs, nil
		}
		return nil, fmt.Errorf("client key groups: %w", err)
	}
	var recs []GroupRecord
	if err := json.Unmarshal(raw, &recs); err != nil {
		return nil, fmt.Errorf("client key groups %s: %w", path, err)
	}
	for _, r := range recs {
		if strings.TrimSpace(r.ID) == "" || strings.TrimSpace(r.Name) == "" {
			log.Printf("WARN: client key groups: 跳过缺少 id/name 的分组条目 %q", r.Name)
			continue
		}
		gs.recs = append(gs.recs, r)
	}
	gs.reindexLocked()
	return gs, nil
}

// Path 返回落盘路径（面板展示用）。
func (gs *GroupStore) Path() string {
	if gs == nil {
		return ""
	}
	return gs.path
}

// Len 返回分组数量。
func (gs *GroupStore) Len() int {
	if gs == nil {
		return 0
	}
	gs.mu.RLock()
	defer gs.mu.RUnlock()
	return len(gs.recs)
}

func (gs *GroupStore) reindexLocked() {
	gs.byID = make(map[string]int, len(gs.recs))
	gs.byKey = make(map[string]int, len(gs.recs))
	for i, r := range gs.recs {
		gs.byID[r.ID] = i
		gs.byKey[r.ID] = i
	}
}

func (gs *GroupStore) saveLocked() error {
	if gs.path == "" {
		return errors.New("client key groups: 未配置存储路径")
	}
	raw, err := json.MarshalIndent(gs.recs, "", "  ")
	if err != nil {
		return err
	}
	if dir := filepath.Dir(gs.path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return safefile.WriteKeep(gs.path, raw, 0o600)
}

// GroupInput 创建/更新分组的入参。
type GroupInput struct {
	Name   *string   `json:"name"`
	Models *[]string `json:"models"`
}

// normalizeModels 去空白、去重、排序。
func normalizeModels(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, m := range in {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		if _, dup := seen[m]; dup {
			continue
		}
		seen[m] = struct{}{}
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

func validateGroupName(name string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("分组名称不能为空")
	}
	if strings.ContainsAny(name, "\r\n") {
		return errors.New("分组名称不能包含换行")
	}
	if len([]rune(name)) > 48 {
		return errors.New("分组名称不能超过 48 个字符")
	}
	return nil
}

// CreateGroup 新建分组，返回落盘记录。
func (gs *GroupStore) CreateGroup(in GroupInput) (GroupRecord, error) {
	name := ""
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
	}
	if err := validateGroupName(name); err != nil {
		return GroupRecord{}, err
	}
	models := []string{}
	if in.Models != nil {
		models = normalizeModels(*in.Models)
	}
	now := time.Now()
	gs.mu.Lock()
	defer gs.mu.Unlock()
	r := GroupRecord{
		ID:        newID(now, len(gs.recs)),
		Name:      name,
		Models:    models,
		CreatedAt: now,
		UpdatedAt: now,
	}
	gs.recs = append(gs.recs, r)
	gs.reindexLocked()
	if err := gs.saveLocked(); err != nil {
		gs.recs = gs.recs[:len(gs.recs)-1]
		gs.reindexLocked()
		return GroupRecord{}, fmt.Errorf("保存分组失败: %w", err)
	}
	return r, nil
}

// UpdateGroup 更新分组（名称/白名单）。未提供的字段不动。
func (gs *GroupStore) UpdateGroup(id string, in GroupInput) (GroupRecord, error) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	idx, ok := gs.byID[id]
	if !ok || idx >= len(gs.recs) {
		return GroupRecord{}, ErrNotFound
	}
	r := &gs.recs[idx]
	prev := *r
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if err := validateGroupName(name); err != nil {
			return GroupRecord{}, err
		}
		r.Name = name
	}
	if in.Models != nil {
		r.Models = normalizeModels(*in.Models)
	}
	r.UpdatedAt = time.Now()
	gs.reindexLocked()
	if err := gs.saveLocked(); err != nil {
		gs.recs[idx] = prev
		gs.reindexLocked()
		return GroupRecord{}, fmt.Errorf("保存分组失败: %w", err)
	}
	return *r, nil
}

// DeleteGroup 删除分组。归属它的 key 的 Group 字段悬空（认证侧视为无分组）。
func (gs *GroupStore) DeleteGroup(id string) error {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	idx, ok := gs.byID[id]
	if !ok || idx >= len(gs.recs) {
		return ErrNotFound
	}
	gs.recs = append(gs.recs[:idx], gs.recs[idx+1:]...)
	gs.reindexLocked()
	if err := gs.saveLocked(); err != nil {
		return fmt.Errorf("保存分组失败: %w", err)
	}
	return nil
}

// ListGroups 返回全部分组（创建序）。
func (gs *GroupStore) ListGroups() []GroupRecord {
	if gs == nil {
		return nil
	}
	gs.mu.RLock()
	defer gs.mu.RUnlock()
	out := make([]GroupRecord, len(gs.recs))
	copy(out, gs.recs)
	return out
}

// GroupByID 按 id 取分组（不存在返回 false）。
func (gs *GroupStore) GroupByID(id string) (GroupRecord, bool) {
	if gs == nil {
		return GroupRecord{}, false
	}
	gs.mu.RLock()
	defer gs.mu.RUnlock()
	idx, ok := gs.byID[id]
	if !ok || idx >= len(gs.recs) {
		return GroupRecord{}, false
	}
	r := gs.recs[idx]
	r.Models = append([]string{}, r.Models...)
	return r, true
}

// ModelsForGroup 返回某分组的模型白名单（副本）。分组不存在或白名单为空返回 nil。
func (gs *GroupStore) ModelsForGroup(id string) []string {
	if gs == nil || id == "" {
		return nil
	}
	gs.mu.RLock()
	defer gs.mu.RUnlock()
	idx, ok := gs.byID[id]
	if !ok || idx >= len(gs.recs) {
		return nil
	}
	models := gs.recs[idx].Models
	if len(models) == 0 {
		return nil
	}
	out := make([]string, len(models))
	copy(out, models)
	return out
}
