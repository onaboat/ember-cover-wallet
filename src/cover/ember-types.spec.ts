import { expect, test } from 'vitest'

import { isCoverable } from './ember-types.ts'

test('covered decision is coverable', () => {
  expect(isCoverable({ coverStatus: 'covered' })).toBe(true)
})

test('unavailable decision is not coverable', () => {
  expect(isCoverable({ coverStatus: 'unavailable' })).toBe(false)
})
