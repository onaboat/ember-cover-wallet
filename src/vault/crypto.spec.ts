import { expect, test } from 'vitest'

import { decryptKey, encryptKey } from './crypto.ts'

const secret = new Uint8Array(32).fill(7)

test('round-trips the secret with the right password', async () => {
  const rec = await encryptKey(secret, 'Str0ng-pass-correct-horse', 'PUBKEY')
  expect(Array.from(await decryptKey(rec, 'Str0ng-pass-correct-horse'))).toEqual(Array.from(secret))
})

test('wrong password fails', async () => {
  const rec = await encryptKey(secret, 'Str0ng-pass-correct-horse', 'PUBKEY')
  await expect(decryptKey(rec, 'wrong-password-entirely')).rejects.toThrow()
})

test('tampering with the authenticated metadata fails', async () => {
  const rec = await encryptKey(secret, 'Str0ng-pass-correct-horse', 'PUBKEY')
  await expect(decryptKey({ ...rec, publicKey: 'ATTACKER' }, 'Str0ng-pass-correct-horse')).rejects.toThrow()
})
