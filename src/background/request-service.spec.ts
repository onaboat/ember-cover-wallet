import {
  address as toAddress,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test, vi } from 'vitest'

import { RequestService } from './request-service.ts'

const FEE_PAYER = 'So11111111111111111111111111111111111111112'

function dummyTxBytes(): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(toAddress(FEE_PAYER), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n },
        m,
      ),
  )
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)))
}

const signer = {
  getAddress: async () => 'So11111111111111111111111111111111111111112',
  sign: async (_m: Uint8Array) => new Uint8Array(64),
}

beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
})

test('rejects a second concurrent request', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('connect', undefined)
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await expect(svc.create('connect', undefined)).rejects.toThrow('already exists')
})

test('approveSignMessage settles with a 64-byte signature output', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ message: Uint8Array.from([1, 2, 3]) } as never])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignMessage()
  const [out] = await pending
  expect(out?.signature.length).toBe(64)
})

test('approveSignTransaction settles with a signed transaction', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [{ transaction: dummyTxBytes() } as never])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction()
  const [out] = await pending
  expect(out?.signedTransaction).toBeDefined()
})

test('reject settles the pending promise with an error', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('connect', undefined)
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  svc.reject()
  await expect(pending).rejects.toThrow('rejected')
})

test('closing the request window rejects the pending promise', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 7 } as never)
  const pending = svc.create('connect', undefined)
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  fakeBrowser.windows.onRemoved.trigger(7)
  await expect(pending).rejects.toThrow('closed')
})

test('attaches an opaque cover decision to a signTransaction request', async () => {
  const cover = {
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      reasonCodes: ['SECRET_INTERNAL_CODE'],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    postSign: async () => {},
    enroll: async () => true,
    isEnrolled: async () => true,
  }
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [{ transaction: dummyTxBytes() } as never])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))
})

test('a malformed signTransaction does not crash the cover fetch (fail-open)', async () => {
  const cover = {
    preSign: async () => {
      throw new Error('should not be called with malformed input')
    },
    postSign: async () => {},
    enroll: async () => true,
    isEnrolled: async () => true,
  }
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [{ transaction: null } as never])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  // give the fire-and-forget cover fetch a tick; it must NOT throw or set a cover decision
  await new Promise((r) => setTimeout(r, 50))
  expect(svc.get()?.cover).toBeUndefined()
})

test('never leaks reasonCodes into the view', async () => {
  const cover = {
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      reasonCodes: ['SECRET_INTERNAL_CODE'],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    postSign: async () => {},
    enroll: async () => true,
    isEnrolled: async () => true,
  }
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [{ transaction: dummyTxBytes() } as never])
  await vi.waitFor(() => expect(svc.get()?.cover).toBeDefined())
  expect(JSON.stringify(svc.get())).not.toContain('SECRET_INTERNAL_CODE')
})
