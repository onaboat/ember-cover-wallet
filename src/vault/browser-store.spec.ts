import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test } from 'vitest'

import { BrowserVaultStore } from './browser-store.ts'

beforeEach(() => {
  fakeBrowser.reset()
})

const record = { salt: 's', argon2Params: { m: 1, t: 1, p: 1 }, iv: 'i', ciphertext: 'c', publicKey: 'PUB' }

test('persists and returns the record', async () => {
  const store = new BrowserVaultStore()
  await store.put(record)
  expect((await store.get())?.publicKey).toBe('PUB')
})

test('clear removes the record', async () => {
  const store = new BrowserVaultStore()
  await store.put(record)
  await store.clear()
  expect(await store.get()).toBeNull()
})
