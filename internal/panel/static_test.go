package panel

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestStaticRejectsTraversal /panel/assets/* 不得被目录穿越读到任意文件。
//
// 资源来自 embed.FS（本身拒绝 ".."），但 handler 是唯一入口：万一以后改成
// 读真实目录，这层校验就是最后一道闸。这里直接测 handler 契约。
func TestStaticRejectsTraversal(t *testing.T) {
	p := newTestPanel()
	for _, path := range []string{
		"/panel/assets/../../etc/passwd",
		"/panel/assets/..%2f..%2fetc%2fpasswd",
		"/panel/assets/",
	} {
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code == http.StatusOK {
			t.Errorf("%s 返回 200，目录穿越未被挡住", path)
		}
	}
}

// TestStaticServesBuiltAssets 有构建产物时，/panel/assets/* 必须按正确 MIME 输出。
//
// MIME 是这里的关键：CSP 的 script-src 'self' 要求 JS 以 text/javascript 提供，
// 若用 http.DetectContentType 嗅探成 text/plain，浏览器会拒绝执行整包脚本，
// 现象是「页面白屏，但网络面板里所有请求都是 200」——很难查。
func TestStaticServesBuiltAssets(t *testing.T) {
	if !hasDist() {
		t.Skip("未构建 React 产物（internal/panel/dist 为空），跳过")
	}

	// 从 dist/index.html 里找出真实的入口脚本名，避免硬编码 hash。
	script := ""
	entryRe := regexp.MustCompile(`src="(/panel/assets/[^"]+\.js)"`)
	if m := entryRe.FindStringSubmatch(string(distIndex)); m != nil {
		script = m[1]
	}
	if script == "" {
		t.Fatal("dist/index.html 里找不到带 hash 的入口脚本引用")
	}

	p := newTestPanel()
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", script, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("%s 状态码=%d want 200", script, rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("%s Content-Type=%q want text/javascript", script, ct)
	}
	// 带内容 hash 的产物应长缓存；入口页才是 no-store。
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("%s Cache-Control=%q want immutable", script, cc)
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Error("静态资源缺少 CSP 头")
	}
}

// TestIndexPrefersDistAndKeepsNoStore 有产物时入口页必须是 React 版，且不得被缓存。
func TestIndexPrefersDistAndKeepsNoStore(t *testing.T) {
	if !hasDist() {
		t.Skip("未构建 React 产物，跳过")
	}
	p := newTestPanel()
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/panel/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码=%d want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
		t.Errorf("入口页 Cache-Control=%q，必须 no-store：否则会拿到旧 HTML 配新 chunk", cc)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `id="root"`) {
		t.Error("有 dist 时应输出 React 版入口页（含 #root）")
	}
	if strings.Contains(body, `id="btnLogout"`) {
		t.Error("有 dist 时不应再输出旧版页面")
	}
}

// TestDistNeverEmpty 保证 internal/panel/dist 目录里始终至少有一个文件。
//
// go:embed all:dist 在目录缺失（或为空）时是**编译期**错误，而 git 不跟踪空目录：
// 一旦产物被清掉，clone 下来就编译不过。
//
// 占位文件叫 .gitkeep-dist 而不是 .gitkeep：Vite 的 emptyOutDir 每次构建都会清空
// outDir，只有 public/ 里被复制过去的文件才留得下来。所以占位文件放在
// web/public/.gitkeep-dist，构建后随样式一起落到 dist。
func TestDistNeverEmpty(t *testing.T) {
	entries, err := os.ReadDir("dist")
	if err != nil {
		t.Fatalf("internal/panel/dist 缺失：go:embed all:dist 会编译失败（%v）", err)
	}
	if len(entries) == 0 {
		t.Fatal("internal/panel/dist 为空：go:embed all:dist 会编译失败")
	}
	// 占位文件必须在源码树里（web/public），否则下次构建就丢了。
	if _, err := os.Stat(filepath.Join("..", "..", "web", "public", ".gitkeep-dist")); err != nil {
		t.Fatalf("web/public/.gitkeep-dist 缺失：构建后 dist 可能变空（%v）", err)
	}
}

// TestFaviconCacheRevalidate favicon 这类固定名字的产物必须可再验证。
//
// 回归点：它曾被设成 `public, max-age=86400`。文件名不带内容 hash，一升级
// 图标内容就变而 URL 不变，浏览器（和更顽固的 favicon 独立缓存）会继续显示
// 旧图标，用户按 Ctrl+F5 都救不回来——只能清浏览器缓存。
// 正确做法是 no-cache + ETag：每次条件请求，没变就 304，变了立刻生效。
func TestFaviconCacheRevalidate(t *testing.T) {
	p := newTestPanel()

	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, httptest.NewRequest("GET", "/panel/favicon.svg", nil))
	if rec.Code != http.StatusOK {
		t.Skipf("dist 里没有 favicon.svg（纯后端构建），跳过；code=%d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); strings.Contains(cc, "max-age") {
		t.Errorf("Cache-Control=%q 不应带 max-age：固定文件名加长缓存会让换图标不生效", cc)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("缺少 ETag，浏览器无法做条件请求，只能每次全量重下")
	}

	// 带上 If-None-Match 应当拿到 304，且没有 body。
	req := httptest.NewRequest("GET", "/panel/favicon.svg", nil)
	req.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	p.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusNotModified {
		t.Errorf("条件请求返回 %d，期望 304", rec2.Code)
	}
	if rec2.Body.Len() != 0 {
		t.Errorf("304 不应带 body，实际 %d 字节", rec2.Body.Len())
	}

	// 不匹配的 ETag 必须返回完整内容，否则改了内容用户也拿不到新的。
	req2 := httptest.NewRequest("GET", "/panel/favicon.svg", nil)
	req2.Header.Set("If-None-Match", `"stale"`)
	rec3 := httptest.NewRecorder()
	p.ServeHTTP(rec3, req2)
	if rec3.Code != http.StatusOK || rec3.Body.Len() == 0 {
		t.Errorf("ETag 不匹配时应返回 200 + 完整内容，实际 %d / %d 字节", rec3.Code, rec3.Body.Len())
	}
}
