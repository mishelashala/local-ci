import { Alert, Snackbar } from '@mui/material';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

export type ToastSeverity = 'success' | 'error' | 'warning' | 'info';

type Toast = { id: number; severity: ToastSeverity; message: string };

const ToastContext = createContext<(severity: ToastSeverity, message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const notify = useCallback((severity: ToastSeverity, message: string) => {
    setToast({ id: Date.now(), severity, message });
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <Snackbar
        key={toast?.id}
        open={toast !== null}
        autoHideDuration={toast?.severity === 'error' ? 8000 : 4500}
        onClose={(_event, reason) => {
          if (reason === 'clickaway') return;
          setToast(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={toast?.severity ?? 'info'}
          variant="filled"
          onClose={() => setToast(null)}
          sx={{ minWidth: 320, fontWeight: 600, alignItems: 'center' }}
        >
          {toast?.message}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
