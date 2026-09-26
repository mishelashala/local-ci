import { describe, expect, it } from 'vitest'
import { formatCount } from './format-count'

describe('formatCount', () => {
  it('keeps a singular noun for one', () => {
    expect(formatCount(1, 'test')).toBe('1 test')
  })

  it('pluralizes zero and many', () => {
    expect(formatCount(0, 'test')).toBe('0 tests')
    expect(formatCount(3, 'test')).toBe('3 tests')
  })
})
