import { ThemeProvider } from '@mui/material';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { type ColorMode, createCiTheme } from './theme';

const STORAGE_KEY = 'ci-color-mode';

type ColorModeValue = {
  mode: ColorMode;
  toggle: () => void;
};

const ColorModeContext = createContext<ColorModeValue | null>(null);

function initialMode(): ColorMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ColorMode>(initialMode);
  const theme = useMemo(() => createCiTheme(mode), [mode]);
  const value = useMemo<ColorModeValue>(
    () => ({
      mode,
      toggle: () => {
        setMode((current) => {
          const next = current === 'dark' ? 'light' : 'dark';
          localStorage.setItem(STORAGE_KEY, next);
          return next;
        });
      },
    }),
    [mode],
  );

  return (
    <ColorModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </ColorModeContext.Provider>
  );
}

export function useColorMode() {
  const value = useContext(ColorModeContext);
  if (!value) {
    throw new Error('useColorMode must be used inside ColorModeProvider');
  }
  return value;
}
