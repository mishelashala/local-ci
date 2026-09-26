export function formatCount(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`
  return `${count} ${noun}s`
}
