import { spawn } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tasks = [
  ['scheduler', ['run', 'dev', '--prefix', 'scheduler']],
  ['dashboard', ['run', 'build:watch', '--prefix', 'dashboard']],
]
const children = tasks.map(([label, args]) => {
  const child = spawn(npm, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('exit', (code, signal) => {
    if (signal) console.error(`${label} stopped (${signal})`)
    else if (code !== 0) console.error(`${label} exited with code ${code}`)
    for (const other of children) if (other !== child && !other.killed) other.kill('SIGTERM')
    process.exitCode = code ?? 1
  })
  return child
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) if (!child.killed) child.kill(signal)
  })
}
