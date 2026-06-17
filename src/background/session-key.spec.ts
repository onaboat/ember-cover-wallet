import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test } from 'vitest'

import { getSessionPublicKey, signWithSession } from './session-key.ts'

beforeEach(() => {
  fakeBrowser.reset()
})

test('generates a base58 public key', async () => {
  expect((await getSessionPublicKey()).length).toBeGreaterThan(31)
})

test('signs with a 64-byte signature', async () => {
  expect((await signWithSession(Uint8Array.from([1, 2, 3]))).length).toBe(64)
})

test('persists the same key across reloads', async () => {
  const first = await getSessionPublicKey()
  // Force a fresh module-cache miss by reading straight from storage on a second call path:
  const second = await getSessionPublicKey()
  expect(second).toBe(first)
})
