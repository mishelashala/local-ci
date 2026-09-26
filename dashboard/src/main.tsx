import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline } from '@mui/material'
import { ColorModeProvider } from './color-mode'
import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ColorModeProvider>
      <CssBaseline />
      <App />
    </ColorModeProvider>
  </StrictMode>,
)
