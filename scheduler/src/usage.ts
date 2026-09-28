import os from 'node:os';

type CpuTimes = { idle: number; total: number };

export function usageFromSamples(
  previous: CpuTimes | null,
  current: CpuTimes,
  memory: { total: number; free: number },
): { cpu: number | null; ramUsedGb: number; ramTotalGb: number } {
  const used = Math.max(0, memory.total - memory.free);
  const ramUsedGb = Math.round((used / 1024 ** 3) * 10) / 10;
  const ramTotalGb = Math.round((memory.total / 1024 ** 3) * 10) / 10;
  if (!previous || current.total <= previous.total) {
    return { cpu: null, ramUsedGb, ramTotalGb };
  }
  const totalDelta = current.total - previous.total;
  const idleDelta = Math.max(0, current.idle - previous.idle);
  const cpu = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  return { cpu, ramUsedGb, ramTotalGb };
}

function readCpu(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

let previous: CpuTimes | null = null;

export function sampleUsage() {
  const current = readCpu();
  const sample = usageFromSamples(previous, current, { total: os.totalmem(), free: os.freemem() });
  previous = current;
  return sample;
}
