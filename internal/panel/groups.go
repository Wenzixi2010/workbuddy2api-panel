// groups.go 面板「分组」页签：客户 Key 分组管理 + 分组→模型白名单。
//
// 分组是独立实体（gateway_groups.json），key 通过 group 字段归属；归属分组的
// key 在网关 chat 路径上只能调用该分组白名单内的模型（internal/server/clientkey.go
// 的 clientKeyGroupAllows）。
package panel

import (
	"encoding/json"
	"net/http"

	"github.com/misakano7545/workbuddy2api-panel/internal/gatewaykey"
)

// groupsStore 返回分组存储；未启用或载入失败时 null。
func (p *Panel) groupsStore(w http.ResponseWriter) *gatewaykey.GroupStore {
	if p.cfg.Groups == nil {
		writeErr(w, http.StatusNotImplemented, "客户 Key 分组未启用或存储载入失败（检查启动日志里的 [gatewaykey] 行）")
		return nil
	}
	return p.cfg.Groups
}

// groups 列出全部分组。
//
//	GET /panel/api/groups
func (p *Panel) groups(w http.ResponseWriter, _ *http.Request) {
	if p.cfg.Groups == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "enabled": false, "groups": []any{},
			"error": "客户 Key 分组未启用或存储载入失败（检查启动日志里的 [gatewaykey] 行）",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"enabled": true,
		"groups":  p.cfg.Groups.ListGroups(),
		"path":    p.cfg.Groups.Path(),
	})
}

// groupCreate 新建分组。
//
//	POST /panel/api/groups
//	body: {"name":"...","models":["cn:glm-5.2","global:claude-x",...]}
func (p *Panel) groupCreate(w http.ResponseWriter, r *http.Request) {
	store := p.groupsStore(w)
	if store == nil {
		return
	}
	var in gatewaykey.GroupInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	rec, err := store.CreateGroup(in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "group": rec})
}

// groupUpdate 更新分组（名称/白名单）。
//
//	POST /panel/api/groups/{id}
func (p *Panel) groupUpdate(w http.ResponseWriter, r *http.Request) {
	store := p.groupsStore(w)
	if store == nil {
		return
	}
	id := r.PathValue("id")
	var in gatewaykey.GroupInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	rec, err := store.UpdateGroup(id, in)
	if err != nil {
		status := http.StatusBadRequest
		if err == gatewaykey.ErrNotFound {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "group": rec})
}

// groupDelete 删除分组。归属它的 key 的 group 字段悬空（认证侧视为无分组）。
//
//	POST /panel/api/groups/{id}/delete
func (p *Panel) groupDelete(w http.ResponseWriter, r *http.Request) {
	store := p.groupsStore(w)
	if store == nil {
		return
	}
	id := r.PathValue("id")
	if err := store.DeleteGroup(id); err != nil {
		status := http.StatusBadRequest
		if err == gatewaykey.ErrNotFound {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
