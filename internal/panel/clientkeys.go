// clientkeys.go 面板「API Keys」页签：签发/编辑/停用/删除下游客户 Key，
// 绑定上游账号（独占）与设置每个 Key 的积分额度。
//
// 与 apikey.go 的区别（两处名字容易混）：
//   - apikey.go 是「把一把**上游** CodeBuddy 静态 Key 当成一个账号加进池子」；
//   - 本文件是「签发一把**下游**网关 Key 给客户端/客户用」。
//
// 安全口径：
//   - 明文 Key 只在创建/轮换那一次出现在响应里（存储只有 sha256），因此列表接口
//     永远不回明文。想换一把就轮换——这也顺带解决了「截屏泄了」的场景。
//   - 这些接口挂在面板鉴权之后（只有主密钥能进），客户 Key 不能管理客户 Key。
package panel

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/misakano7545/workbuddy2api-panel/internal/gatewaykey"
)

// clientKeysEnabled 报告客户 Key 功能开关当前状态（热配置；nil = 未接 Live）。
func (p *Panel) clientKeysEnabled() bool {
	if p.cfg.ClientKeysEnabled != nil {
		return p.cfg.ClientKeysEnabled()
	}
	return p.cfg.ClientKeys != nil
}

// clientKeysStore 返回存储；未启用或载入失败时 null。
func (p *Panel) clientKeysStore(w http.ResponseWriter) *gatewaykey.Store {
	if p.cfg.ClientKeys == nil {
		writeErr(w, http.StatusNotImplemented, "客户 API Key 未启用或存储载入失败（检查启动日志里的 [gatewaykey] 行与 config client_keys）")
		return nil
	}
	return p.cfg.ClientKeys
}

// clientKeys 列出全部客户 Key（不含明文）。
//
//	GET /panel/api/client_keys
//
// 响应里带 enabled：前端据此区分「功能关了」与「还没建任何 Key」——两者的空表格
// 长得一样，但一句提示能省一次问「为什么我建不了」。
func (p *Panel) clientKeys(w http.ResponseWriter, _ *http.Request) {
	if p.cfg.ClientKeys == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "enabled": false, "keys": []any{},
			"error": "客户 API Key 未启用或存储载入失败（检查启动日志里的 [gatewaykey] 行）",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"enabled": p.clientKeysEnabled(),
		"keys":    p.cfg.ClientKeys.List(),
		"path":    p.cfg.ClientKeys.Path(),
	})
}

// clientKeyCreate 签发一把新 Key。
//
//	POST /panel/api/client_keys
//	body: {"name":"...","remark":"...","binds":["uid1",...],"limits":{"period":"day|total","credits":10}}
//
// 响应里的 "key" 是**唯一一次**能看到明文的地方，前端必须当场展示并提示保存。
func (p *Panel) clientKeyCreate(w http.ResponseWriter, r *http.Request) {
	store := p.clientKeysStore(w)
	if store == nil {
		return
	}
	if !p.clientKeysEnabled() {
		writeErr(w, http.StatusConflict, "客户 API Key 功能已关闭（config client_keys.enabled=false），先打开再签发")
		return
	}
	// 直接解 Input：嵌入的指针字段（name/remark/binds/limits/disabled）让「没传」
	// 与「传了空」可区分。前端每次都整份提交，这里不需要更多形状。
	var in gatewaykey.Input
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	plain, view, err := store.Create(in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "key": plain, "client_key": view})
}

// clientKeyUpdate 更新一把 Key 的配置（未提供的字段不动）。
//
//	POST /panel/api/client_keys/{id}
func (p *Panel) clientKeyUpdate(w http.ResponseWriter, r *http.Request) {
	store := p.clientKeysStore(w)
	if store == nil {
		return
	}
	id := r.PathValue("id")
	var in gatewaykey.Input
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	view, err := store.Update(id, in)
	if err != nil {
		status := http.StatusBadRequest
		if err == gatewaykey.ErrNotFound {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "client_key": view})
}

// clientKeyDelete 删除一把 Key（明文立即失效）。
//
//	POST /panel/api/client_keys/{id}/delete
//
// 用 POST + /delete 而不是 DELETE 方法：面板前端统一走 fetch POST（见 app.js 的
// api() 辅助函数），混用方法只会让调用点多一种失败模式。
func (p *Panel) clientKeyDelete(w http.ResponseWriter, r *http.Request) {
	store := p.clientKeysStore(w)
	if store == nil {
		return
	}
	id := r.PathValue("id")
	ok, err := store.Delete(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "客户 Key 不存在")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// clientKeyRotate 轮换明文（旧 key 立即失效，绑定与额度配置保留）。
//
//	POST /panel/api/client_keys/{id}/rotate
//	body（可选）: {"key":"自定义明文"}——给了就用它轮换，不给则随机生成。
func (p *Panel) clientKeyRotate(w http.ResponseWriter, r *http.Request) {
	store := p.clientKeysStore(w)
	if store == nil {
		return
	}
	id := r.PathValue("id")
	var req struct {
		Key string `json:"key"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // 空 body 不算错：随机轮换
	}
	var (
		plain string
		view  gatewaykey.View
		err   error
	)
	if strings.TrimSpace(req.Key) != "" {
		plain, view, err = store.RotateTo(id, req.Key)
	} else {
		plain, view, err = store.Rotate(id)
	}
	if err != nil {
		status := http.StatusBadRequest
		if err == gatewaykey.ErrNotFound {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "key": plain, "client_key": view})
}

// clientKeyResetUsage 把一把 Key 的额度游标归零（累计总额度的「充值」）。
//
//	POST /panel/api/client_keys/{id}/reset_usage
func (p *Panel) clientKeyResetUsage(w http.ResponseWriter, r *http.Request) {
	store := p.clientKeysStore(w)
	if store == nil {
		return
	}
	view, err := store.ResetUsage(r.PathValue("id"))
	if err != nil {
		status := http.StatusBadRequest
		if err == gatewaykey.ErrNotFound {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "client_key": view})
}

// clientKeyBindableAccounts 返回「可以绑定给 Key」的账号清单（uid + 昵称 + 当前绑定
// 归属），供前端渲染勾选树。
//
// 为什么单独一个端点而不是复用 /overview：overview 的账号模型很重（额度、冷却、
// 任务状态…），勾选框只需要 uid/昵称/是否已被谁独占。
func (p *Panel) clientKeyBindableAccounts(w http.ResponseWriter, _ *http.Request) {
	if p.cfg.ClientKeys == nil || p.cfg.Pool == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accounts": []any{}})
		return
	}
	// owner：uid → 已在用它的 Key 名字（多把 Key 绑定同一个号时只显示第一个，
	// 前端据此提示「会与 X 共享」）。
	owner := map[string]string{}
	for _, v := range p.cfg.ClientKeys.List() {
		for _, uid := range v.Binds {
			if owner[uid] == "" {
				owner[uid] = v.Name
				if owner[uid] == "" {
					owner[uid] = v.ID
				}
			}
		}
	}
	type acct struct {
		UID      string `json:"uid"`
		Nickname string `json:"nickname"`
		Healthy  bool   `json:"healthy"`
		Disabled bool   `json:"disabled"`
		Credits  int64  `json:"credits"`
		Owner    string `json:"owner,omitempty"`
	}
	st := p.cfg.Pool.List()
	out := make([]acct, 0, len(st))
	for _, s := range st {
		out = append(out, acct{
			UID:      s.UID,
			Nickname: s.Nickname,
			Healthy:  !s.Disabled && !s.Cooling && !s.Paused,
			Disabled: s.Disabled,
			Credits:  s.Credits,
			Owner:    owner[s.UID],
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accounts": out})
}
