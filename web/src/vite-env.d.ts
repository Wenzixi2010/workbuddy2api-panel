/// <reference types="vite/client" />

// CSS 以副作用方式引入（import './styles/x.css'）。Vite 负责打包样式，
// TS 只需要知道这些模块存在，否则 tsc 会报「找不到模块」。
declare module '*.css'
