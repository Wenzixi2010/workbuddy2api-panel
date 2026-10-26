import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// 顺序即优先级：legacy 提供设计令牌（CSS 变量）与旧组件底子，
// layout 覆盖布局节奏，app 补具体组件的样式。后者必须能压过前者。
import './styles/legacy.css'
import './styles/layout.css'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
