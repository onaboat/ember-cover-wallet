import { expect, test, vi } from 'vitest'

vi.mock('../../messaging/window.ts', () => ({
  sendMessage: vi.fn(async (_method: string, _inputs: unknown) => [
    { signature: { 0: 1, 1: 2 }, signedMessage: { 0: 3 } },
  ]),
}))

import { sendMessage } from '../../messaging/window.ts'
import { signMessage } from './sign-message.ts'

test('decodes the signature record into a Uint8Array', async () => {
  const [out] = await signMessage({ message: Uint8Array.from([3]) } as never)
  expect(out?.signature).toBeInstanceOf(Uint8Array)
})

test('collapses variadic inputs into one array payload', async () => {
  const a = { message: Uint8Array.from([1]) } as never
  const b = { message: Uint8Array.from([2]) } as never
  await signMessage(a, b)
  expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('signMessage', [a, b])
})
