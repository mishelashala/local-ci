import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0e1116', paper: '#161b22' },
    primary: { main: '#58a6ff' },
    success: { main: '#3fb950' },
    error: { main: '#f85149' },
    warning: { main: '#d29922' },
    info: { main: '#58a6ff' },
    divider: '#30363d',
    text: { primary: '#e6edf3', secondary: '#8b949e' },
  },
  typography: {
    fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
    overline: { letterSpacing: '0.08em', fontWeight: 600, fontSize: 11 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiButton: { styleOverrides: { root: { boxShadow: 'none' } } },
    MuiChip: {
      styleOverrides: {
        root: { height: 22, fontSize: 11, fontWeight: 600 },
        label: { paddingLeft: 8, paddingRight: 8 },
      },
    },
    MuiTooltip: { styleOverrides: { tooltip: { fontSize: 12 } } },
  },
})
