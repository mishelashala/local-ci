import { describe, expect, it } from 'vitest'
import { clamp } from './clamp'

describe('clamp', () => {
  it('leaves an in-range value alone', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('pulls values up to the minimum', () => {
    expect(clamp(-2, 0, 10)).toBe(0)
  })

  it('pulls values down to the maximum', () => {
    expect(clamp(12, 0, 10)).toBe(10)
  })
})
