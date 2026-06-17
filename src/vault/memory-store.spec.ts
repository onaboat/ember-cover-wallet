import { expect, test } from 'vitest'

import { MemoryVaultStore } from './memory-store.ts'

test('returns the record it stored', async () => {
  const store = new MemoryVaultStore()
  await store.put({ salt: 's', argon2Params: { m: 1, t: 1, p: 1 }, iv: 'i', ciphertext: 'c', publicKey: 'p' })
  expect((await store.get())?.publicKey).toBe('p')
})
