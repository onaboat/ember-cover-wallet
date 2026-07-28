import { expect, test } from 'vitest'

import { base58Encode } from '../crypto/base58.ts'
import { buildConnectAccount } from './build-account.ts'

test('decodes the address into a 32-byte public key', () => {
  const address = base58Encode(new Uint8Array(32).fill(7))
  expect(buildConnectAccount(address).publicKey.length).toBe(32)
})
