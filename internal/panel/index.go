// index.go 面板静态资源与安全响应头。
//
// 前端是 web/ 里的 React 应用（Vite 构建），产物落在 internal/panel/dist 并由
// go:embed 打进二进制——部署仍是单文件，没有「另带一个静态目录」的运维成本。
//
// 同时保留旧的一套单文件前端（index.html + app.js）作为**回退**：dist 还没有
// 构建产物时（纯后端开发、或者 CI 里没跑 npm）仍然能开出一个能用的面板，而不是
// 一个 500 或空白页。选择逻辑在 staticMode()。
package panel

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed index.html
var indexHTMLRaw []byte

//go:embed theme.js
var themeJS []byte

//go:embed app.js
var appJS []byte

// distFS React 构建产物。目录必须存在，否则 go:embed 编译期就报错——所以仓库里
// 放了一个 dist/.gitkeep 占位；build.sh 构建时会把真实产物覆盖进去。
//
//go:embed all:dist
var distFS embed.FS

// distIndex dist 里的入口页；不存在说明还没构建过 React 版。
var distIndex = func() []byte {
	b, err := fs.ReadFile(distFS, "dist/index.html")
	if err != nil {
		return nil
	}
	return b
}()

// hasDist 报告是否有可用的 React 构建产物。
func hasDist() bool { return len(distIndex) > 0 }

// 内容指纹（issue #33）：把脚本 URL 绑到脚本内容上。
//
// 为什么需要：面板原先靠 `Cache-Control: no-store` 保证不拿到旧脚本，那是对
// 浏览器的一维约定；中间任何一层（反代缓存、浏览器扩展、企业网关的静态资源
// 缓存、离线缓存）只要回放了一次旧 app.js，新 HTML 配旧 JS 就会因 DOM 结构
// 漂移而中途抛异常。加性防御：no-store 原样保留，URL 另带内容指纹。
//
// React 版由 Vite 在文件名里写 hash，这层机制对它反而更必要——新 HTML 配旧
// chunk 会让 React 拿到 undefined 组件直接白屏，比旧版的「部分功能失效」更难查。
func fingerprint(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// legacyIndex 是把 <script src="theme.js"> / <script src="app.js"> 换成带指纹
// URL 之后的旧版页面字节（React 版不可用时的回退）。
var legacyIndex = func() []byte {
	s := strings.ReplaceAll(string(indexHTMLRaw), `src="theme.js"`, `src="theme.js?v=`+fingerprint(themeJS)+`"`)
	s = strings.ReplaceAll(s, `src="app.js"`, `src="app.js?v=`+fingerprint(appJS)+`"`)
	return []byte(s)
}()

// csp 内容安全策略（严格版，无需 unsafe-inline）：
//   - default-src 'none'        默认全禁，逐个开口
//   - script-src 'self'         只跑同源脚本；React 版的 chunk 也是同源
//   - style-src 'self' 'unsafe-inline'
//     style 的内联是设计取舍：页面有少量 style="..." 属性（进度条宽度），
//     允许内联样式不会导致脚本执行；仍禁止外部样式域与 @import 外链。
//   - connect-src 'self'        前端 fetch 只能打本服务
//   - img-src 'self' data:      图标/内联图
//   - form-action 'none'        页面无表单提交目标
//   - frame-ancestors 'none'    禁止被任何站点 iframe 嵌套（点击劫持）
//   - base-uri 'none'          禁止注入 <base> 改写相对路径
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"connect-src 'self'; img-src 'self' data:; form-action 'none'; " +
	"frame-ancestors 'none'; base-uri 'none'"

// setSecurityHeaders 写入面板统一安全响应头（页面与 API 都要，API 也含 JSON 数据）。
func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
}

// index 输出面板页面（静态无秘密；数据接口 /panel/api/* 才走鉴权）。
//
// React 版：输出 dist/index.html，资源由 /panel/assets/* 提供。
// 回退版：输出旧的单文件页面。
func (p *Panel) index(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if hasDist() {
		_, _ = w.Write(distIndex)
		return
	}
	_, _ = w.Write(legacyIndex)
}

// static 提供 React 产物的静态资源（/panel/assets/*）。
//
// 只有带内容 hash 的产物会走这里；入口页永远 no-store，所以这里可以放心长缓存
// ——文件名变了 URL 就变了，不存在「回放了旧文件」的问题。
func (p *Panel) static(w http.ResponseWriter, r *http.Request) {
	if !hasDist() {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/panel/")
	// 目录穿越防护：embed.FS 本身拒绝 ".."，这里再挡一层 ".." 与绝对路径，
	// 避免把畸形路径当成合法资源去查表。
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(distFS, "dist/"+name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	setSecurityHeaders(w)
	// 资源是不可变内容（文件名含 hash）：给强缓存，减少每次刷新对静态资源的往返。
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if ct := contentTypeOf(name); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// distFile 提供 dist 根目录下的单个具名文件（favicon.svg 这类不参与 hash 的产物）。
//
// 名字来自代码里的常量而非请求路径，所以不存在路径拼接；仍然走一遍 ReadFile，
// 这样产物缺失时是 404 而不是空 200（浏览器拿到空 SVG 会一直重试）。
func (p *Panel) distFile(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !hasDist() {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(distFS, "dist/"+name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		setSecurityHeaders(w)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		if ct := contentTypeOf(name); ct != "" {
			w.Header().Set("Content-Type", ct)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

// contentTypeOf 按扩展名给出 Content-Type。
//
// 不交给 http.DetectContentType：它对 .js 会嗅探成 text/plain，而 CSP 的
// script-src 要求正确的 JS MIME，浏览器会因此拒绝执行整包脚本（白屏）。
func contentTypeOf(name string) string {
	switch {
	case strings.HasSuffix(name, ".js"), strings.HasSuffix(name, ".mjs"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".json"):
		return "application/json; charset=utf-8"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".woff2"):
		return "font/woff2"
	case strings.HasSuffix(name, ".map"):
		return "application/json; charset=utf-8"
	}
	return ""
}

// themeScript 输出首屏主题预热脚本。
//
// 它必须被 <head> 以同步外链方式加载（CSP 禁内联）：晚于样式表就回到「刷新先闪深色」，
// 因为用户的明暗偏好只存在浏览器 localStorage 里，服务端无从得知。
func (p *Panel) themeScript(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(themeJS)
}

// appScript 输出旧版前端逻辑（React 版不可用时的回退路径）。
func (p *Panel) appScript(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(appJS)
}
