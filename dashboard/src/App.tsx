import { Board } from './components/Board';
import { ToastProvider } from './toast';

export function App() {
  return (
    <ToastProvider>
      <Board />
    </ToastProvider>
  );
}
