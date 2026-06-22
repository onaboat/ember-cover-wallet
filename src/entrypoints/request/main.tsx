import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../../assets/global.css'
import { App } from '../popup/App.tsx'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element not found')
}
createRoot(root).render(
  <StrictMode>
    <App mode="approval" />
  </StrictMode>,
)
