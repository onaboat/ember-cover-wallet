import { expect, test } from 'vitest'

import { assessPassword } from './password-policy.ts'

test('rejects a too-short password', () => {
  expect(assessPassword('Ab1!').ok).toBe(false)
})

test('accepts a simple password with no composition rule', () => {
  expect(assessPassword('alllowercaseonly').ok).toBe(true)
})

test('accepts a strong password', () => {
  expect(assessPassword('Str0ng-pass-correct-horse').ok).toBe(true)
})

test('has no maximum length', () => {
  expect(assessPassword('a'.repeat(10_000)).ok).toBe(true)
})
