import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { minimatch } from 'minimatch';
import YAML from 'yaml';

export interface WorkflowRunner {
  run(input: {
    workspace: string;
    repository: string;
    ref: string;
    sha: string;
    headSha: string;
    baseSha: string;
    target: 'develop' | 'main' | 'reconcile' | 'post-merge' | 'smoke';
    runId: string;
    signal: AbortSignal;
    log: (line: string, workflowPath?: string) => void;
    onWorkflows?: (paths: string[]) => void;
    onWorkflowStart?: (path: string) => void;
    onWorkflowFinish?: (path: string, exitCode: number) => void;
  }): Promise<number>;
}

/** GitHub ubuntu-latest is linux/amd64. Packages such as phantomjs-prebuilt ship no
 *  linux/arm64 binary, so that is the default on an arm64 Mac too. */
export function containerArchitecture(configured = process.env.LOCAL_CI_CONTAINER_ARCH): string {
  const chosen = configured?.trim();
  if (chosen) {
    return chosen;
  }
  return 'linux/amd64';
}

/** act copies the image PATH into later steps. On an arm64 Mac that PATH points at
 *  `.../arm64/bin` while `--container-architecture linux/amd64` puts `node` in `.../x64/bin`. */
const GH_VERSION = '2.88.1';
const GH_SHA256 = {
  amd64: '36352a993b97e9758793cdb87f9ba674bd6d88c914488e122be78a1962203803',
  arm64: '039ce25aab0cfa0ea5160e3db75ed44699bde4b20ff63ec5991f82201f1b33b8',
} as const;

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Job containers do not include GitHub's `gh`. Mount a linux binary into /usr/local/bin. */
export function ghContainerOption(binary: string): string {
  return `--volume ${quoteArg(binary)}:/usr/local/bin/gh:ro`;
}

export function actEnvContents(pathValue: string, token: string | null, projectEnv = ''): string {
  const kept = projectEnv.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return Boolean(trimmed);
    }
    const key = trimmed.split('=', 1)[0];
    return key !== 'PATH' && key !== 'GH_TOKEN' && key !== 'GITHUB_TOKEN';
  });
  const lines = [...kept, `PATH=${pathValue}`];
  if (token) {
    lines.push(`GH_TOKEN=${token}`, `GITHUB_TOKEN=${token}`);
  }
  return `${lines.join('\n')}\n`;
}

function hostGhToken(): string | null {
  // A GITHUB_TOKEN in the scheduler environment can be a narrower credential than
  // `gh auth login`. Prefer the stored gh login, which can read private repos.
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', env }).trim();
    if (token) {
      return token;
    }
  } catch {
    /* host gh is missing or logged out */
  }
  return process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || null;
}

export async function ensureLinuxGh(toolsDir: string, arch: keyof typeof GH_SHA256): Promise<string> {
  const dest = join(toolsDir, `gh-${GH_VERSION}-linux-${arch}`);
  if (existsSync(dest)) {
    return dest;
  }
  mkdirSync(toolsDir, { recursive: true });
  const name = `gh_${GH_VERSION}_linux_${arch}.tar.gz`;
  const response = await fetch(`https://github.com/cli/cli/releases/download/v${GH_VERSION}/${name}`);
  if (!response.ok) {
    throw new Error(`download gh failed (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== GH_SHA256[arch]) {
    throw new Error('gh checksum mismatch');
  }
  const extractDir = join(toolsDir, `gh-extract-${arch}`);
  const archive = join(toolsDir, `${name}.partial`);
  writeFileSync(archive, bytes);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir);
  try {
    execFileSync('tar', ['-xzf', archive, '-C', extractDir]);
    const extracted = join(extractDir, `gh_${GH_VERSION}_linux_${arch}`, 'bin', 'gh');
    if (!existsSync(extracted)) {
      throw new Error('gh archive did not contain bin/gh');
    }
    const staging = `${dest}.partial`;
    renameSync(extracted, staging);
    chmodSync(staging, 0o755);
    if (!existsSync(dest)) {
      renameSync(staging, dest);
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(archive, { force: true });
    rmSync(`${dest}.partial`, { force: true });
  }
  if (!existsSync(dest)) {
    throw new Error('gh binary was not installed');
  }
  return dest;
}

export function actContainerPath(imagePath = ''): string {
  const bins = new Set<string>();
  for (const entry of imagePath.split(':')) {
    if (!entry.includes('/node/') || !entry.endsWith('/bin')) {
      continue;
    }
    bins.add(entry);
    if (entry.includes('/arm64/')) {
      bins.add(entry.replace('/arm64/', '/x64/'));
    }
    if (entry.includes('/x64/')) {
      bins.add(entry.replace('/x64/', '/arm64/'));
    }
  }
  if (bins.size === 0) {
    bins.add('/opt/acttoolcache/node/24.19.0/x64/bin');
    bins.add('/opt/acttoolcache/node/24.19.0/arm64/bin');
  }
  const ordered = [...bins].sort((left, right) => Number(right.includes('/x64/')) - Number(left.includes('/x64/')));
  return [...ordered, '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'].join(':');
}

const timeoutMinutes = Number(process.env.LOCAL_CI_RUN_TIMEOUT_MINUTES ?? 45);
export const runTimeoutMs =
  Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : 45 * 60_000;

function streamLines(stream: NodeJS.ReadableStream | null, log: (line: string) => void) {
  let pending = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r\n|\r|\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line) {
        log(line);
      }
    }
  });
  return () => {
    if (pending) {
      log(pending);
    }
  };
}

function collectHostPorts(node: unknown, ports: number[]) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectHostPorts(item, ports);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.ports)) {
    for (const entry of record.ports) {
      if (typeof entry === 'string') {
        const match = entry.trim().match(/^(\d{1,5}):\d{1,5}(?:\/(?:tcp|udp))?$/);
        const port = match ? Number(match[1]) : 0;
        if (port > 0 && port < 65536) {
          ports.push(port);
        }
      } else if (entry && typeof entry === 'object' && 'published' in entry) {
        const port = Number((entry as { published?: unknown }).published);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          ports.push(port);
        }
      }
    }
  }
  for (const value of Object.values(record)) {
    collectHostPorts(value, ports);
  }
}

function hostPortsIn(node: unknown): number[] {
  const ports: number[] = [];
  collectHostPorts(node, ports);
  return [...new Set(ports)];
}

function hostPorts(source: string): number[] {
  try {
    return hostPortsIn(YAML.parse(source));
  } catch {
    return [];
  }
}

function replaceHostPort(source: string, from: number, to: number): string {
  const mapping = new RegExp(`(^|[\\s'"])${from}(\\s*:\\s*)(\\d{1,5})(?!\\d)`, 'g');
  return source
    .replace(mapping, `$1${to}$2$3`)
    .replace(new RegExp(`(published:\\s*)${from}(?!\\d)`, 'g'), `$1${to}`)
    .replace(new RegExp(`(localhost|127\\.0\\.0\\.1):${from}(?!\\d)`, 'g'), `$1:${to}`);
}

function jobBodies(source: string): { start: number; end: number; ports: number[] }[] {
  let document: YAML.Document;
  try {
    document = YAML.parseDocument(source);
  } catch {
    return [];
  }
  const jobs = document.get('jobs', true);
  if (!YAML.isMap(jobs)) {
    return [];
  }
  const bodies: { start: number; end: number; ports: number[] }[] = [];
  for (const item of jobs.items) {
    const value = item.value;
    if (!value || !YAML.isNode(value) || !value.range) {
      continue;
    }
    bodies.push({
      start: value.range[0],
      end: value.range[2] ?? value.range[1],
      ports: hostPortsIn(value.toJS(document)),
    });
  }
  return bodies;
}

function allocateHostPort(
  preferred: number,
  busy: (port: number) => boolean,
  nextPort: () => number,
  reserved: Set<number>,
  assigned: Set<number>,
): number {
  if (!busy(preferred) && !assigned.has(preferred)) {
    assigned.add(preferred);
    return preferred;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = nextPort();
    if (candidate > 0 && !assigned.has(candidate) && !reserved.has(candidate) && !busy(candidate)) {
      assigned.add(candidate);
      reserved.add(candidate);
      return candidate;
    }
  }
  return 0;
}

export function remapHostPorts(
  source: string,
  busy: (port: number) => boolean,
  nextPort: () => number,
): { text: string; changes: { from: number; to: number }[] } {
  const bodies = jobBodies(source);
  const reserved = new Set(hostPorts(source));
  const assigned = new Set<number>();
  const changes: { from: number; to: number }[] = [];
  if (bodies.length === 0) {
    let text = source;
    for (const port of [...reserved]) {
      const replacement = allocateHostPort(port, busy, nextPort, reserved, assigned);
      if (replacement === 0 || replacement === port) {
        continue;
      }
      changes.push({ from: port, to: replacement });
      text = replaceHostPort(text, port, replacement);
    }
    return { text, changes };
  }
  const edits: { start: number; end: number; text: string }[] = [];
  for (const body of bodies) {
    let text = source.slice(body.start, body.end);
    for (const port of body.ports) {
      const replacement = allocateHostPort(port, busy, nextPort, reserved, assigned);
      if (replacement === 0 || replacement === port) {
        continue;
      }
      changes.push({ from: port, to: replacement });
      text = replaceHostPort(text, port, replacement);
    }
    if (text !== source.slice(body.start, body.end)) {
      edits.push({ start: body.start, end: body.end, text });
    }
  }
  edits.sort((left, right) => right.start - left.start);
  let text = source;
  for (const edit of edits) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return { text, changes };
}

function freshPortCount(source: string, busy: (port: number) => boolean): number {
  const bodies = jobBodies(source);
  const groups = bodies.length > 0 ? bodies.map((body) => body.ports) : [hostPorts(source)];
  const assigned = new Set<number>();
  let count = 0;
  for (const ports of groups) {
    for (const port of ports) {
      if (!busy(port) && !assigned.has(port)) {
        assigned.add(port);
      } else {
        count++;
      }
    }
  }
  return count;
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function portBusy(port: number): Promise<boolean> {
  if (!(await canListen(port, '0.0.0.0'))) {
    return true;
  }
  return !(await canListen(port, '::'));
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function actImage(): string {
  const platform = process.env.LOCAL_CI_ACT_PLATFORM ?? 'ubuntu-latest=catthehacker/ubuntu:act-latest';
  return platform.split('=').pop() || 'catthehacker/ubuntu:act-latest';
}

function actImagePath(): string {
  try {
    const raw = execFileSync(
      'docker',
      ['image', 'inspect', actImage(), '--format', '{{range .Config.Env}}{{println .}}{{end}}'],
      { encoding: 'utf8' },
    );
    return (
      raw
        .split('\n')
        .find((line) => line.startsWith('PATH='))
        ?.slice('PATH='.length) ?? ''
    );
  } catch {
    return '';
  }
}

async function remapBusyHostPorts(source: string) {
  const ports = hostPorts(source);
  const busy = new Set<number>();
  for (const port of ports) {
    if (await portBusy(port)) {
      busy.add(port);
    }
  }
  const needed = freshPortCount(source, (port) => busy.has(port));
  const free: number[] = [];
  for (let index = 0; index < Math.max(needed, 1) * 5 && free.length < needed; index++) {
    const candidate = await ephemeralPort();
    if (
      candidate > 0 &&
      !ports.includes(candidate) &&
      !busy.has(candidate) &&
      !free.includes(candidate) &&
      !(await portBusy(candidate))
    ) {
      free.push(candidate);
    }
  }
  let index = 0;
  return remapHostPorts(
    source,
    (port) => busy.has(port),
    () => free[index++] ?? 0,
  );
}

function stopProcess(child: ChildProcess) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      /* already stopped */
    }
  }
  child.kill('SIGTERM');
}

type PullRequestTrigger = {
  branches?: string[];
  'branches-ignore'?: string[];
  paths?: string[];
  'paths-ignore'?: string[];
  types?: string[];
};

function matches(patterns: string[] | undefined, value: string) {
  return patterns?.some((pattern) => minimatch(value, pattern)) ?? false;
}

function selectedWorkflows(input: Parameters<WorkflowRunner['run']>[0]) {
  if (input.target === 'smoke') {
    const file = '.local-ci/workflows/develop-smoke.yml';
    if (!existsSync(join(input.workspace, file))) {
      throw new Error('post-merge smoke workflow disappeared from the tested commit');
    }
    const workflow = YAML.parse(readFileSync(join(input.workspace, file), 'utf8')) as {
      on?: { push?: { branches?: string[] } };
    };
    if (!workflow?.on?.push || (workflow.on.push.branches && !matches(workflow.on.push.branches, 'develop'))) {
      throw new Error('develop-smoke.yml must declare on: push for develop');
    }
    return [file];
  }
  const relative = existsSync(join(input.workspace, '.local-ci', 'workflows'))
    ? '.local-ci/workflows'
    : '.github/workflows';
  const directory = join(input.workspace, relative);
  if (!existsSync(directory)) {
    throw new Error('no .local-ci/workflows or .github/workflows directory at the candidate SHA');
  }
  const files = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error('no workflow YAML files at the candidate SHA');
  }
  const base = input.target === 'main' ? 'main' : 'develop';
  const changes = execFileSync('git', ['diff', '--name-only', `${input.baseSha}...${input.headSha}`], {
    cwd: input.workspace,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  let prWorkflows = 0;
  const selected = files.filter((name) => {
    const workflow = YAML.parse(readFileSync(join(directory, name), 'utf8')) as {
      on?: { pull_request?: PullRequestTrigger | null };
    } | null;
    const trigger = workflow?.on?.pull_request;
    if (trigger === undefined) {
      return false;
    }
    const rules = trigger ?? {};
    if (rules.types && !rules.types.some((type) => type === 'opened' || type === 'synchronize')) {
      return false;
    }
    prWorkflows++;
    if (rules.branches && !matches(rules.branches, base)) {
      return false;
    }
    if (matches(rules['branches-ignore'], base)) {
      return false;
    }
    if (rules.paths && !changes.some((path) => matches(rules.paths, path))) {
      return false;
    }
    if (rules['paths-ignore'] && changes.length > 0 && changes.every((path) => matches(rules['paths-ignore'], path))) {
      return false;
    }
    return true;
  });
  if (prWorkflows === 0) {
    throw new Error('no pull_request test workflow found (closed/reset workflows do not validate a push)');
  }
  return selected.map((name) => `${relative}/${name}`);
}

export class ActWorkflowRunner implements WorkflowRunner {
  async run(input: Parameters<WorkflowRunner['run']>[0]): Promise<number> {
    let selected: string[];
    try {
      selected = selectedWorkflows(input);
    } catch (error) {
      input.log(`error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (selected.length === 0) {
      input.log('All pull_request workflows are excluded by branch/path filters; GitHub would run no checks.');
      return 0;
    }
    input.onWorkflows?.(selected);
    const base = input.target === 'main' ? 'main' : 'develop';
    const head = input.ref.replace(/^refs\/heads\//, '');
    // act copies this disposable checkout into the job container. Its origin URL is a
    // host path, so prepare the ratchet ref here instead of fetching inside the job.
    execFileSync(
      'git',
      [
        'update-ref',
        'refs/remotes/origin/develop',
        input.target === 'smoke' ? input.sha : input.target === 'main' ? input.headSha : input.baseSha,
      ],
      { cwd: input.workspace },
    );
    const eventPath = join(input.workspace, '.local-ci-event.json');
    writeFileSync(
      eventPath,
      JSON.stringify(
        input.target === 'smoke'
          ? {
              ref: 'refs/heads/develop',
              before: input.baseSha,
              after: input.sha,
              repository: { full_name: input.repository },
            }
          : {
              action: 'synchronize',
              number: 1,
              ref: 'refs/pull/1/merge',
              repository: { full_name: input.repository },
              pull_request: {
                number: 1,
                merged: false,
                merge_commit_sha: input.sha,
                head: { ref: head, sha: input.headSha, repo: { full_name: input.repository } },
                base: { ref: base, sha: input.baseSha, repo: { full_name: input.repository } },
              },
            },
      ),
    );
    const artifacts = join(dirname(input.workspace), 'artifacts', input.runId);
    mkdirSync(artifacts, { recursive: true });
    input.log(`Pull request ${head} -> ${base}; candidate ${input.sha}; workflows: ${selected.join(', ')}`);
    const pathValue = actContainerPath(actImagePath());
    let ghBinary: string | null = null;
    let envFile: string | null = null;
    if (!process.env.LOCAL_CI_TEST_CAPTURE) {
      try {
        const arch = containerArchitecture().endsWith('arm64') ? 'arm64' : 'amd64';
        ghBinary = await ensureLinuxGh(join(dirname(dirname(input.workspace)), 'tools'), arch);
        const token = hostGhToken();
        if (!token) {
          input.log('warning: gh has no token on this machine; steps that call gh cannot authenticate');
        }
        envFile = join(tmpdir(), `local-ci-${input.runId}.env`);
        const projectEnv = join(input.workspace, '.env');
        writeFileSync(
          envFile,
          actEnvContents(pathValue, token, existsSync(projectEnv) ? readFileSync(projectEnv, 'utf8') : ''),
          { mode: 0o600 },
        );
        input.log('mounted linux gh into job containers');
      } catch (error) {
        input.log(`warning: could not prepare gh: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let result = 0;
    try {
      for (const file of selected) {
        if (input.signal.aborted) {
          return 1;
        }
        input.onWorkflowStart?.(file);
        const workflowPath = join(input.workspace, file);
        const original = readFileSync(workflowPath, 'utf8');
        const remapped = await remapBusyHostPorts(original);
        if (remapped.text !== original) {
          writeFileSync(workflowPath, remapped.text);
        }
        for (const change of remapped.changes) {
          input.log(`host port ${change.from} is in use; using ${change.to}`, file);
        }
        const artifactPort = await ephemeralPort();
        const args = [
          input.target === 'smoke' ? 'push' : 'pull_request',
          '-C',
          input.workspace,
          '-W',
          file,
          '--eventpath',
          eventPath,
          '--artifact-server-path',
          artifacts,
          '--artifact-server-port',
          String(artifactPort),
          '--cache-server-port',
          '0',
          '--pull=false',
          '--concurrent-jobs',
          process.env.LOCAL_CI_CONCURRENT_JOBS ?? '1',
          ...(envFile ? ['--env-file', envFile] : ['--env', `PATH=${pathValue}`]),
          ...(ghBinary ? ['--container-options', ghContainerOption(ghBinary)] : []),
          '--container-architecture',
          containerArchitecture(),
          '-P',
          process.env.LOCAL_CI_ACT_PLATFORM ?? 'ubuntu-latest=catthehacker/ubuntu:act-latest',
        ];
        input.log(`act ${args.join(' ')}`);
        const code = await new Promise<number>((resolve) => {
          const child = spawn('act', args, {
            cwd: input.workspace,
            detached: process.platform !== 'win32',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: 'true' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const workflowLog = (line: string) => input.log(line, file);
          const flushOut = streamLines(child.stdout, workflowLog);
          const flushErr = streamLines(child.stderr, workflowLog);
          const abort = () => stopProcess(child);
          input.signal.addEventListener('abort', abort, { once: true });
          if (input.signal.aborted) {
            abort();
          }
          let settled = false;
          const done = (exit: number) => {
            if (settled) {
              return;
            }
            settled = true;
            input.signal.removeEventListener('abort', abort);
            flushOut();
            flushErr();
            resolve(exit);
          };
          child.on('error', (error: NodeJS.ErrnoException) => {
            workflowLog(
              error.code === 'ENOENT' ? 'error: act is not installed or is not on PATH' : `error: ${error.message}`,
            );
            done(1);
          });
          child.on('close', (exit) => done(exit ?? 1));
        });
        input.onWorkflowFinish?.(file, code);
        if (code !== 0) {
          result = code;
        }
      }
      input.log(`Artifacts (if any): ${artifacts}`);
      return result;
    } finally {
      if (envFile) {
        rmSync(envFile, { force: true });
      }
    }
  }
}
