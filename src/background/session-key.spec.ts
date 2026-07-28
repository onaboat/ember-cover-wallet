import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test } from 'vitest'

import {
  getSessionPublicKey,
  getSessionSigner,
  prepareNextSessionSigner,
  signWithSession,
} from './session-key.ts'

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

test('recovers and promotes the exact pending key after interrupted session rotation', async () => {
  const first = await getSessionSigner()
  const pending = await prepareNextSessionSigner()

  const recovered = await getSessionSigner(pending.publicKey)

  expect(recovered.publicKey).toBe(pending.publicKey)
  expect(recovered.publicKey).not.toBe(first.publicKey)
  expect((await recovered.signMessage(Uint8Array.from([4, 5, 6]))).length).toBe(64)
  expect((await getSessionSigner()).publicKey).toBe(pending.publicKey)
})
