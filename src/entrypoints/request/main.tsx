import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { RequestApp } from './RequestApp.tsx'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element not found')
}
createRoot(root).render(
  <StrictMode>
    <RequestApp />
  </StrictMode>,
)
