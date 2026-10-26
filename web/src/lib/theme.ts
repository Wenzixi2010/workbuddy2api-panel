/** 主题：先跟随系统，点了就固定为浅/深并落盘。 */
import { LS_THEME } from './api'

export type ThemePref = 'auto' | 'light' | 'dark'
export type ThemeEff = 'light' | 'dark'

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(LS_THEME)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* 隐私模式 */
  }
  return 'auto'
}

export function systemTheme(): ThemeEff {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

/**
 * 有效主题。
 *
 * 判定必须与 public/theme.js 逐字一致：那边在样式表之前先画一帧，这边接管之后
 * 如果算出不同结果，就会「先深后浅」闪一下。脏值（既非 auto 也非 light/dark）
 * 两边都直接当 data-theme 用——行为一致优先于看起来安全。
 */
export function effectiveTheme(pref: ThemePref): ThemeEff {
  return pref === 'auto' ? systemTheme() : pref
}

export function applyTheme(eff: ThemeEff) {
  document.documentElement.setAttribute('data-theme', eff)
}

export function writeThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(LS_THEME, pref)
  } catch {
    /* 存不进去不影响本次会话 */
  }
}
