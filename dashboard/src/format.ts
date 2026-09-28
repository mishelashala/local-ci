import type { Run, RunKind } from './types';

export const mono = '"IBM Plex Mono", ui-monospace, monospace';
export const LINE_MS = 1100;

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

export function formatAgo(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function runDuration(run: Run, now: number): string {
  if (!run.startedAt) {
    return 'queued';
  }
  return formatDuration((run.finishedAt ?? now) - run.startedAt);
}

export function lineStamp(run: Run, index: number): string {
  const start = run.startedAt ?? run.createdAt;
  return formatClock(start + index * LINE_MS);
}

export function kindLabel(kind: RunKind): string {
  switch (kind) {
    case 'merge-validation':
      return 'merge candidate';
    case 'promote-main':
      return 'promote main';
    case 'push':
      return 'push';
    case 'manual':
      return 'manual';
  }
}

export function machineLoad(now: number, busy: boolean): { cpu: number; ramGb: number } {
  const wave = Math.sin(now / 700) * 0.5 + Math.sin(now / 1700) * 0.5;
  const cpu = Math.round(Math.min(94, Math.max(4, (busy ? 64 : 8) + wave * (busy ? 16 : 3))));
  const ramGb = Number(((busy ? 6.9 : 1.5) + wave * (busy ? 0.45 : 0.08)).toFixed(1));
  return { cpu, ramGb };
}

export function mixSha(a: string, b: string): string {
  let out = '';
  for (let i = 0; i < 40; i += 1) {
    const left = Number.parseInt(a[i] ?? '0', 16);
    const right = Number.parseInt(b[i] ?? '0', 16);
    const n = Number.isNaN(left) ? 0 : left;
    const m = Number.isNaN(right) ? 0 : right;
    out += ((n + m + i) % 16).toString(16);
  }
  return out;
}

export function makeSha(seed: number): string {
  let out = '';
  let x = seed >>> 0;
  for (let i = 0; i < 40; i += 1) {
    x = Math.imul(x, 1664525) + 1013904223 + i;
    x >>>= 0;
    out += (x % 16).toString(16);
  }
  return out;
}

export function splitLog(line: string): [string, string] {
  const index = line.indexOf('|');
  if (index === -1) {
    return ['log', line];
  }
  return [line.slice(0, index), line.slice(index + 1)];
}
