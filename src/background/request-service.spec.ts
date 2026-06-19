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

import { buildConnectAccount } from './build-account.ts'
import type { CoverProvider } from './cover-service.ts'
import { RequestService } from './request-service.ts'

const FEE_PAYER = 'So11111111111111111111111111111111111111112'
const ACCOUNT = buildConnectAccount(FEE_PAYER)

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
  getAddress: async () => FEE_PAYER,
  sign: async (_m: Uint8Array) => new Uint8Array(64),
}

function coverProvider(overrides: Partial<CoverProvider>): CoverProvider {
  return {
    preSign: async () => ({
      requestId: '',
      coverStatus: 'unavailable',
      riskBand: 'severe',
      reasonCodes: [],
      decisionExpiresAt: new Date(0).toISOString(),
    }),
    postSign: async () => {},
    status: async () => null,
    preSignMessage: async () => ({
      requestId: '',
      coverStatus: 'unavailable',
      riskBand: 'severe',
      reasonCodes: [],
      decisionExpiresAt: new Date(0).toISOString(),
    }),
    postSignMessage: async () => {},
    enroll: async () => true,
    isEnrolled: async () => true,
    ...overrides,
  }
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
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: Uint8Array.from([1, 2, 3]) }])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignMessage()
  const [out] = await pending
  expect(out?.signature.length).toBe(64)
})

test('approveSignMessage rejects multiple messages so the UI cannot sign a hidden batch', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [
    { account: ACCOUNT, message: Uint8Array.from([1]) },
    { account: ACCOUNT, message: Uint8Array.from([2]) },
  ])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await expect(svc.approveSignMessage()).rejects.toThrow('Multiple message signing is not supported')
  svc.reject()
})

test('attaches an opaque cover decision to a signMessage request', async () => {
  const cover = coverProvider({
    preSignMessage: async () => ({
      requestId: 'msg-r',
      coverStatus: 'unsupported' as const,
      riskBand: 'high' as const,
      reasonCodes: ['SECRET_INTERNAL_CODE'],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
      capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
      coveredTxCountImpact: 1,
    }),
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signMessage', [{ account: ACCOUNT, message: Uint8Array.from([1, 2, 3]) }])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('unsupported'))
  expect(svc.get()?.cover?.riskBand).toBe('high')
  expect(svc.get()?.cover?.capContext).toEqual({ monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 })
  expect(JSON.stringify(svc.get())).not.toContain('SECRET_INTERNAL_CODE')
})

test('approveSignMessage posts signed-message evidence for a backend decision', async () => {
  const postSignMessage = vi.fn(async () => {})
  const cover = coverProvider({
    preSignMessage: async () => ({
      requestId: 'msg-r',
      coverStatus: 'unsupported' as const,
      riskBand: 'high' as const,
      reasonCodes: ['unknown_message_schema'],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    postSignMessage,
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: Uint8Array.from([1, 2, 3]) }])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('unsupported'))

  await svc.approveSignMessage()
  await pending

  expect(postSignMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'msg-r',
      signedMessage: 'AQID',
      signingWalletPublicKey: FEE_PAYER,
      highRiskAckAt: expect.any(String),
    }),
  )
})

test('approveSignMessage rejects an expired covered decision before signing', async () => {
  const sign = vi.fn(async (_m: Uint8Array) => new Uint8Array(64))
  const cover = coverProvider({
    preSignMessage: async () => ({
      requestId: 'expired-msg',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      reasonCodes: [],
      decisionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  })
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: Uint8Array.from([1, 2, 3]) }])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await expect(svc.approveSignMessage()).rejects.toThrow('Cover decision expired')

  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('approveSignTransaction settles with a signed transaction', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [{ account: ACCOUNT, transaction: dummyTxBytes() }])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction()
  const [out] = await pending
  expect(out?.signedTransaction).toBeDefined()
})

test('approveSignTransaction rejects multiple transactions so the UI cannot sign a hidden batch', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [
    { account: ACCOUNT, transaction: dummyTxBytes() },
    { account: ACCOUNT, transaction: dummyTxBytes() },
  ])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await expect(svc.approveSignTransaction()).rejects.toThrow('Multiple transaction signing is not supported')
  svc.reject()
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
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      reasonCodes: ['SECRET_INTERNAL_CODE'],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
      capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
      coveredTxCountImpact: 1,
    }),
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [{ account: ACCOUNT, transaction: dummyTxBytes() }])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))
  expect(svc.get()?.cover?.decisionExpiresAt).toBeDefined()
  expect(svc.get()?.cover?.capContext).toEqual({ monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 })
  expect(svc.get()?.cover?.coveredTxCountImpact).toBe(1)
})

test('refreshCover replaces an expired or stale cover decision', async () => {
  let calls = 0
  const cover = coverProvider({
    preSign: async () => {
      calls += 1
      return {
        requestId: `r-${calls}`,
        coverStatus: 'covered' as const,
        riskBand: 'low' as const,
        reasonCodes: [],
        decisionExpiresAt: new Date(Date.now() + calls * 60000).toISOString(),
      }
    },
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [{ account: ACCOUNT, transaction: dummyTxBytes() }])
  await vi.waitFor(() => expect(svc.get()?.cover?.decisionExpiresAt).toBeDefined())
  const firstExpiry = svc.get()?.cover?.decisionExpiresAt

  const refreshed = await svc.refreshCover()

  expect(calls).toBe(2)
  expect(refreshed?.cover?.decisionExpiresAt).not.toBe(firstExpiry)
})

test('approveSignTransaction rejects an expired covered decision before signing', async () => {
  const sign = vi.fn(async (_m: Uint8Array) => new Uint8Array(64))
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'expired',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      reasonCodes: [],
      decisionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  })
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [{ account: ACCOUNT, transaction: dummyTxBytes() }])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await expect(svc.approveSignTransaction()).rejects.toThrow('Cover decision expired')

  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('a malformed signTransaction does not crash the cover fetch (fail-open)', async () => {
  const cover = coverProvider({
    preSign: async () => {
      throw new Error('should not be called with malformed input')
    },
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [{ account: ACCOUNT, transaction: null } as never])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  // give the fire-and-forget cover fetch a tick; it must NOT throw or set a cover decision
  await new Promise((r) => setTimeout(r, 50))
  expect(svc.get()?.cover).toBeUndefined()
})

test('never leaks reasonCodes into the view', async () => {
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      reasonCodes: ['SECRET_INTERNAL_CODE'],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [{ account: ACCOUNT, transaction: dummyTxBytes() }])
  await vi.waitFor(() => expect(svc.get()?.cover).toBeDefined())
  const view = svc.get()
  expect(JSON.stringify(view)).not.toContain('SECRET_INTERNAL_CODE')
})

test('zero remaining cap on a covered decision stays covered and posts evidence', async () => {
  const postSign = vi.fn(async () => {})
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      reasonCodes: [],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
      capContext: { remainingCoveredTxThisMonth: 0 },
      coveredTxCountImpact: 1,
    }),
    postSign,
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [{ account: ACCOUNT, transaction: dummyTxBytes() }])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await svc.approveSignTransaction()
  await pending

  expect(postSign).toHaveBeenCalledOnce()
})

test('exhausted cap is not covered and skips post sign evidence', async () => {
  const postSign = vi.fn(async () => {})
  const cover = coverProvider({
    preSign: async () => ({
      requestId: '',
      coverStatus: 'not_covered' as const,
      riskBand: 'severe' as const,
      reasonCodes: ['transaction_count_exhausted'],
      decisionExpiresAt: new Date(0).toISOString(),
      capContext: { remainingCoveredTxThisMonth: 0 },
      coveredTxCountImpact: 0,
    }),
    postSign,
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [{ account: ACCOUNT, transaction: dummyTxBytes() }])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('not_covered'))

  await svc.approveSignTransaction()
  await pending

  expect(postSign).not.toHaveBeenCalled()
})
