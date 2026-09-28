import { createTheme } from '@mui/material/styles';

export type ColorMode = 'light' | 'dark';

export function createCiTheme(mode: ColorMode) {
  const dark = mode === 'dark';
  return createTheme({
    palette: {
      mode,
      background: dark ? { default: '#0e1116', paper: '#161b22' } : { default: '#f6f8fa', paper: '#ffffff' },
      primary: { main: dark ? '#58a6ff' : '#0969da' },
      success: { main: dark ? '#3fb950' : '#1a7f37' },
      error: { main: dark ? '#f85149' : '#d1242f' },
      warning: { main: dark ? '#d29922' : '#9a6700' },
      info: { main: dark ? '#58a6ff' : '#0969da' },
      divider: dark ? '#30363d' : '#d0d7de',
      text: dark ? { primary: '#e6edf3', secondary: '#8b949e' } : { primary: '#1f2328', secondary: '#656d76' },
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
  });
}
