import { expect, test } from 'vitest'

import { stringifyWithBigInts } from './safe-json.ts'

test('serializes bigint values that plain JSON.stringify rejects', () => {
  // The Solana RPC parses u64s in simulation errors into bigint, which plain
  // JSON.stringify throws on ("Do not know how to serialize a BigInt").
  expect(stringifyWithBigInts({ InstructionError: [0, { Custom: 6001n }] })).toBe(
    '{"InstructionError":[0,{"Custom":"6001"}]}',
  )
})
