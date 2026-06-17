import { expect, test, vi } from 'vitest'

vi.mock('../../messaging/window.ts', () => ({
  sendMessage: vi.fn(async (_method: string, _inputs: unknown) => [{ signedTransaction: { 0: 7, 1: 8 } }]),
}))

import { sendMessage } from '../../messaging/window.ts'
import { signTransaction } from './sign-transaction.ts'

test('decodes the signedTransaction record into a Uint8Array', async () => {
  const [out] = await signTransaction({ transaction: Uint8Array.from([1]) } as never)
  expect(out?.signedTransaction).toBeInstanceOf(Uint8Array)
})

test('collapses variadic inputs into one array payload', async () => {
  const a = { transaction: Uint8Array.from([1]) } as never
  const b = { transaction: Uint8Array.from([2]) } as never
  await signTransaction(a, b)
  expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('signTransaction', [a, b])
})
