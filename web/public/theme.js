'use strict';
/* theme.js 首屏主题预热：由 index.html 的 <head> 以同步脚本加载（必须在样式表之前）。
 *
 * 为什么需要单独一个文件：页面默认写死 data-theme="dark"，而真实的明暗偏好在
 * localStorage['wb2api.theme'] 里。React 挂载在 <body> 末尾，等它跑起来时浏览器早已
 * 按深色画完第一帧——这就是「刷新先闪一下夜间模式再变日间」的成因。把同样的判定提到
 * 样式表解析之前，第一帧画出来就是最终主题。
 *
 * 不能写成内联脚本：CSP 是 script-src 'self'，内联块会被直接拦掉（主题永远停在深色）。
 *
 * 判定规则必须与 web/src/lib/theme.ts 的 effectiveTheme() 逐字一致，否则会「预热一套、
 * React 再翻一套」二次闪烁：只有存了 light / dark 才按存的来，其余（auto、缺失）跟随系统。
 */
(function () {
  var saved = 'auto';
  try {
    saved = localStorage.getItem('wb2api.theme') || 'auto';
  } catch (e) {
    /* 隐私模式或禁用存储：退回跟随系统 */
  }
  var eff = saved === 'auto'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : saved;
  document.documentElement.setAttribute('data-theme', eff);
})();
