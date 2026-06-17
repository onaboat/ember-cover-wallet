import { expect, test } from 'vitest'

import { buildSignMessageOutputs } from './sign-message-output.ts'

test('decodes a record-encoded message before signing (not new Uint8Array(record))', async () => {
  const out = await buildSignMessageOutputs([{ message: { 0: 1, 1: 2, 2: 3 } } as never], async () => new Uint8Array(64))
  expect(Array.from(out[0]!.signedMessage as Uint8Array)).toEqual([1, 2, 3])
})

test('returns a 64-byte signature', async () => {
  const out = await buildSignMessageOutputs([{ message: Uint8Array.from([1]) } as never], async () => new Uint8Array(64))
  expect(out[0]!.signature.length).toBe(64)
})
