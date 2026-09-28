import { useTheme } from '@mui/material';
import type { ColorMode } from './theme';

const ANSI = /\u001b\[([0-9;]*)m/g;

const DARK = ['#6e7681', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#e6edf3'];
const DARK_BRIGHT = ['#8b949e', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'];
const LIGHT = ['#24292f', '#cf222e', '#116329', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#1f2328'];
const LIGHT_BRIGHT = ['#57606a', '#a40e26', '#1a7f37', '#7d4e00', '#0550ae', '#6639ba', '#0e6e75', '#1f2328'];

type Span = {
  text: string;
  color?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
};

function palette(mode: ColorMode, bright: boolean) {
  if (mode === 'dark') return bright ? DARK_BRIGHT : DARK;
  return bright ? LIGHT_BRIGHT : LIGHT;
}

function applyCode(
  style: { color?: string; background?: string; bold: boolean; dim: boolean },
  code: number,
  mode: ColorMode,
) {
  if (code === 0) {
    style.color = undefined;
    style.background = undefined;
    style.bold = false;
    style.dim = false;
    return;
  }
  if (code === 1) style.bold = true;
  if (code === 2) style.dim = true;
  if (code === 22) {
    style.bold = false;
    style.dim = false;
  }
  if (code === 39) style.color = undefined;
  if (code === 49) style.background = undefined;
  if (code >= 30 && code <= 37) style.color = palette(mode, false)[code - 30];
  if (code >= 90 && code <= 97) style.color = palette(mode, true)[code - 90];
  if (code >= 40 && code <= 47) style.background = palette(mode, false)[code - 40];
  if (code >= 100 && code <= 107) style.background = palette(mode, true)[code - 100];
}

export function parseAnsi(text: string, mode: ColorMode): Span[] {
  const spans: Span[] = [];
  const style = {
    color: undefined as string | undefined,
    background: undefined as string | undefined,
    bold: false,
    dim: false,
  };
  let cursor = 0;
  for (const match of text.matchAll(ANSI)) {
    const index = match.index ?? 0;
    if (index > cursor) spans.push({ text: text.slice(cursor, index), ...style });
    const codes = match[1].length === 0 ? [0] : match[1].split(';').map((part) => Number(part));
    for (const code of codes) {
      if (Number.isFinite(code)) applyCode(style, code, mode);
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), ...style });
  return spans.filter((span) => span.text.length > 0);
}

export function AnsiText({ text }: { text: string }) {
  const mode = useTheme().palette.mode;
  const spans = parseAnsi(text, mode === 'light' ? 'light' : 'dark');
  return (
    <>
      {spans.map((span, index) => (
        <span
          key={index}
          style={{
            color: span.color,
            background: span.background,
            fontWeight: span.bold ? 700 : undefined,
            opacity: span.dim ? 0.72 : undefined,
          }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}
