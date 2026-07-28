import { expect, test } from 'vitest'

import { base58Decode, base58Encode } from './base58.ts'

test('round trips exact bytes including leading zeroes', () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 3, 254, 255])
  expect(base58Decode(base58Encode(bytes))).toEqual(bytes)
})

test('rejects characters outside the Bitcoin/Solana base58 alphabet', () => {
  expect(() => base58Decode('0OIl')).toThrow('invalid base58 character')
})
