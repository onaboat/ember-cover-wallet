import { expect, test } from 'vitest'

import { assessPassword } from './password-policy.ts'

test('rejects a too-short password', () => {
  expect(assessPassword('Ab1!').ok).toBe(false)
})

test('rejects a single-character-class password', () => {
  expect(assessPassword('alllowercaseonly').ok).toBe(false)
})

test('accepts a strong password', () => {
  expect(assessPassword('Str0ng-pass-correct-horse').ok).toBe(true)
})
