import { expect, test } from 'vitest'

import { buildConnectAccount } from './build-account.ts'
import { buildSignMessageOutputs } from './sign-message-output.ts'

const ADDRESS = 'So11111111111111111111111111111111111111112'
const ACCOUNT = buildConnectAccount(ADDRESS)
const OTHER_ACCOUNT = buildConnectAccount('11111111111111111111111111111112')

test('decodes a record-encoded message before signing (not new Uint8Array(record))', async () => {
  const out = await buildSignMessageOutputs(
    [{ account: ACCOUNT, message: { 0: 1, 1: 2, 2: 3 } as never }],
    async () => new Uint8Array(64),
    ADDRESS,
  )
  expect(Array.from(out[0]!.signedMessage as Uint8Array)).toEqual([1, 2, 3])
})

test('returns a 64-byte signature', async () => {
  const out = await buildSignMessageOutputs(
    [{ account: ACCOUNT, message: Uint8Array.from([1]) }],
    async () => new Uint8Array(64),
    ADDRESS,
  )
  expect(out[0]!.signature.length).toBe(64)
})

test('rejects a message request for another account', async () => {
  await expect(
    buildSignMessageOutputs([{ account: OTHER_ACCOUNT, message: Uint8Array.from([1]) }], async () => new Uint8Array(64), ADDRESS),
  ).rejects.toThrow('Account does not match vault')
})
