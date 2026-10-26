// modeltest.go 面板「模型与档位」的可用性测试：用**指定账号**发一个最小非流式
// 对话请求，返回成功/失败与耗时，供运维确认「账号 A 在当前模型 X 上还通不通」。
//
// 与 searchtool.probeOnce 的区别：那边是「按 realm 随机选号」探测 web_search 工具；
// 这里是「指定 uid」直连测试，不选号、不参与冷却/熔断（applyErrorPolicy 不动——
// 测试不该因为一次人工探测就把账号打进冷却）。
package panel

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/misakano7545/workbuddy2api-panel/internal/upstream"
)

// modelTest 用指定账号测试模型可用性。
//
//	POST /panel/api/models/test
//	body: {"uid":"...","model":"model-id"}   // model 可选，空 = 账号默认模型
//
// 返回：{"ok":true,"elapsed_ms":N,"content":"首段回复预览","model":"实际模型",
// "usage":{...}} 或 4xx/502 + 错误说明。
func (p *Panel) modelTest(w http.ResponseWriter, r *http.Request) {
	if p.cfg.Pool == nil || p.cfg.Upstream == nil {
		writeErr(w, http.StatusNotImplemented, "网关未装配账号池/上游客户端，无法测试")
		return
	}
	var req struct {
		UID   string `json:"uid"`
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	req.UID = strings.TrimSpace(req.UID)
	req.Model = strings.TrimSpace(req.Model)
	if req.UID == "" {
		writeErr(w, http.StatusBadRequest, "uid 必填")
		return
	}
	a := p.cfg.Pool.AuthByUID(req.UID)
	if a == nil {
		writeErr(w, http.StatusNotFound, "账号不存在")
		return
	}

	// 最小请求：一句话 + 非流式 + 16 token 上限，够判「通不通」又不烧积分。
	model := req.Model
	if model == "" {
		model = "auto" // 交给上游按账号默认档位路由
	}
	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"messages":   []map[string]any{{"role": "user", "content": "ping"}},
		"stream":     false,
		"max_tokens": 16,
	})

	start := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	rc, status, respBody, err := p.cfg.Upstream.ChatStreamContext(ctx, a, body, "", upstream.ChatMeta{}, nil)
	_ = respBody // 非流式测试里错误语义已由 err/upstream.Error 表达，respBody 仅作冗余诊断
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		kind := "network"
		msg := err.Error()
		var ue *upstream.Error
		if errors.As(err, &ue) {
			kind = ue.Kind.String()
			if ue.Msg != "" {
				msg = ue.Msg
			}
			if status == 0 {
				status = ue.Status
			}
		}
		log.Printf("panel: model_test uid=%s model=%s → 失败(%s http %d): %s",
			req.UID, model, kind, status, msg)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "elapsed_ms": elapsed, "error": msg,
			"kind": kind, "status": status,
		})
		return
	}
	defer rc.Close()

	obj, aerr := upstream.Aggregate(rc)
	if aerr != nil {
		log.Printf("panel: model_test uid=%s model=%s → 聚合失败: %v", req.UID, model, aerr)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "elapsed_ms": elapsed, "error": aerr.Error(),
			"kind": "aggregate", "status": status,
		})
		return
	}

	// 取首段正文做预览；没有正文（空回复）也算通，只是不展示内容。
	content := ""
	usageAny := any(nil)
	if ch, _ := obj["choices"].([]any); len(ch) > 0 {
		if c, ok := ch[0].(map[string]any); ok {
			if m, ok := c["message"].(map[string]any); ok {
				if s, ok := m["content"].(string); ok {
					content = s
				}
			}
		}
	}
	if u, ok := obj["usage"]; ok {
		usageAny = u
	}
	respModel, _ := obj["model"].(string)
	if respModel == "" {
		respModel = model
	}

	log.Printf("panel: model_test uid=%s model=%s → 成功（%dms，回复 %d 字）",
		req.UID, model, elapsed, len([]rune(content)))
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "elapsed_ms": elapsed, "content": content,
		"model": respModel, "usage": usageAny, "status": status,
	})
}
