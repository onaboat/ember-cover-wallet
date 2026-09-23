import {
  AccountRole,
  appendTransactionMessageInstruction,
  address as toAddress,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { SOLANA_DEVNET_CHAIN } from '@solana/wallet-standard-chains'
import type { SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test, vi } from 'vitest'

import { buildConnectAccount } from './build-account.ts'
import type { CoverProvider } from './cover-service.ts'
import { RequestService } from './request-service.ts'
import type { SigningConsent } from '../signing/signing-policy.ts'

function consent(svc: RequestService): SigningConsent {
  return { reviewId: svc.get()?.signingReview?.reviewId ?? '', acknowledged: ['coverage', 'effects', 'message', 'safety'] }
}
import { preflightTransaction } from './transaction-preflight.ts'

vi.mock('./transaction-preflight.ts', () => ({ preflightTransaction: vi.fn() }))

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

function transactionInput(): SolanaSignTransactionInput {
  return {
    account: ACCOUNT,
    chain: SOLANA_DEVNET_CHAIN,
    transaction: dummyTxBytes(),
  }
}

const signer = {
  getAddress: async () => FEE_PAYER,
  // Non-zero: @solana/kit treats an all-zero 64-byte slot as "unsigned", so
  // getSignatureFromTransaction would reject it (a real vault never signs zeros).
  sign: async (_m: Uint8Array) => new Uint8Array(64).fill(7),
}

function coverProvider(overrides: Partial<CoverProvider>): CoverProvider {
  return {
    preSign: async () => ({
      requestId: '',
      coverStatus: 'unavailable',
      riskBand: 'severe',
      decisionReason: 'temporarily_unavailable',
      decisionExpiresAt: new Date(0).toISOString(),
    }),
    cancelReview: vi.fn(async () => {}),
    postSign: async () => {},
    status: async () => null,
    preSignMessage: async () => ({
      requestId: '',
      coverStatus: 'unavailable',
      riskBand: 'severe',
      decisionReason: 'temporarily_unavailable',
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
  vi.mocked(preflightTransaction).mockReset().mockResolvedValue({ status: 'valid' })
})

test('rejects a second concurrent request', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('connect', undefined)
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await expect(svc.create('connect', undefined)).rejects.toThrow('already exists')
})

test('rejects a chainless transaction before opening an approval window', async () => {
  const svc = new RequestService(signer)
  const createWindow = vi.spyOn(fakeBrowser.windows, 'create')

  await expect(
    svc.create('signTransaction', [
      { account: ACCOUNT, transaction: dummyTxBytes() } as never,
    ]),
  ).rejects.toThrow('chain identifier is required')
  expect(createWindow).not.toHaveBeenCalled()
})

test('approveSignMessage settles with a 64-byte signature output', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: Uint8Array.from([1, 2, 3]) }])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignMessage(undefined, consent(svc))
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
  await expect(svc.approveSignMessage(undefined, consent(svc))).rejects.toThrow('Multiple message signing is not supported')
  svc.reject()
})

test('attaches an opaque cover decision to a signMessage request', async () => {
  const cover = coverProvider({
    preSignMessage: async () => ({
      requestId: 'msg-r',
      coverStatus: 'unsupported' as const,
      riskBand: 'high' as const,
      decisionReason: 'unsupported' as const,
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
      decisionReason: 'unsupported' as const,
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    postSignMessage,
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: Uint8Array.from([1, 2, 3]) }])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('unsupported'))

  await svc.approveSignMessage(undefined, consent(svc))
  await pending

  expect(postSignMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'msg-r',
      signedMessage: 'AQID',
      signingWalletPublicKey: FEE_PAYER,
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
      decisionReason: 'eligible' as const,
      decisionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  })
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: Uint8Array.from([1, 2, 3]) }])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await expect(svc.approveSignMessage(undefined, consent(svc))).rejects.toThrow('Cover decision expired')

  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('approveSignTransaction settles with a signed transaction', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction(undefined, consent(svc))
  const [out] = await pending
  expect(out?.signedTransaction).toBeDefined()
})

test('approveSignTransaction rejects multiple transactions so the UI cannot sign a hidden batch', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [
    transactionInput(),
    transactionInput(),
  ])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('Multiple transaction signing is not supported')
  svc.reject()
})

test('approve closes the one-purpose approval window', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const remove = vi.spyOn(fakeBrowser.windows, 'remove').mockResolvedValue(undefined as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction(undefined, consent(svc))
  await pending
  expect(remove).toHaveBeenCalledWith(1)
})

test('the pending slot is cleared before the approval window closes', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction(undefined, consent(svc))
  await pending
  expect(svc.get()).toBeNull()
})

test('the approval-window removal event after approve does not settle the promise a second time', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 7 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction(undefined, consent(svc))
  const [out] = await pending
  // The service closes the one-purpose approval window: onRemoved must be a no-op now.
  fakeBrowser.windows.onRemoved.trigger(7)
  expect(out?.signedTransaction).toBeDefined()
})

test('reject removes the window', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 9 } as never)
  const remove = vi.spyOn(fakeBrowser.windows, 'remove').mockResolvedValue(undefined as never)
  const pending = svc.create('connect', undefined)
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  svc.reject()
  await expect(pending).rejects.toThrow('rejected')
  expect(remove).toHaveBeenCalledWith(9)
})

test('a stale id cannot approve a request it never displayed', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  const currentId = svc.get()?.id
  await expect(svc.approveSignTransaction('stale-id')).rejects.toThrow('Stale request')
  // The real id still works.
  await svc.approveSignTransaction(currentId, consent(svc))
  const [out] = await pending
  expect(out?.signedTransaction).toBeDefined()
})

test('closing the window after signing starts preserves evidence and completes the request', async () => {
  let releaseSign = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseSign = resolve
  })
  const sign = vi.fn(async (_m: Uint8Array) => {
    await gate
    return new Uint8Array(64).fill(7)
  })
  const postSign = vi.fn(async () => {})
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      decisionReason: 'eligible' as const,
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    postSign,
  })
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 7 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  const approveP = svc.approveSignTransaction(undefined, consent(svc))
  approveP.catch(() => {})
  // The user closes the window while the vault signer is still in flight.
  await vi.waitFor(() => expect(sign).toHaveBeenCalled())
  fakeBrowser.windows.onRemoved.trigger(7)
  releaseSign()

  await approveP
  expect(await pending).toHaveLength(1)
  // Closing UI cannot cancel signing that has already started.
  expect(postSign).toHaveBeenCalledOnce()
  const records = await storage.getItem<unknown[]>('local:ember-cover-records')
  expect(records ?? []).toHaveLength(1)
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
      decisionReason: 'eligible' as const,
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
      capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
      coveredTxCountImpact: 1,
    }),
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [transactionInput()])
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
        decisionReason: 'eligible' as const,
        decisionExpiresAt: new Date(Date.now() + calls * 60000).toISOString(),
      }
    },
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.cover?.decisionExpiresAt).toBeDefined())
  const firstExpiry = svc.get()?.cover?.decisionExpiresAt

  const refreshed = await svc.refreshCover()

  expect(calls).toBe(2)
  expect(refreshed?.cover?.decisionExpiresAt).not.toBe(firstExpiry)
})

test('keeps one delayed cover check in flight, blocks signing, and surfaces its late result', async () => {
  let releaseCover = () => {}
  const coverGate = new Promise<void>((resolve) => {
    releaseCover = resolve
  })
  const sign = vi.fn(async (_m: Uint8Array) => new Uint8Array(64).fill(7))
  const preSign = vi.fn(async () => {
    await coverGate
    return {
      requestId: 'late-covered',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      decisionReason: 'eligible' as const,
      decisionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  })
  const svc = new RequestService(
    { getAddress: signer.getAddress, sign },
    coverProvider({ preSign }),
  )
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})

  await vi.waitFor(() => expect(svc.get()?.coverChecking).toBe(true))
  const refresh = svc.refreshCover()

  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('Cover check is still in progress')
  expect(sign).not.toHaveBeenCalled()
  expect(preSign).toHaveBeenCalledOnce()

  releaseCover()
  const refreshed = await refresh

  expect(refreshed?.coverChecking).toBe(false)
  expect(refreshed?.cover?.coverStatus).toBe('covered')
  expect(preSign).toHaveBeenCalledOnce()
  svc.reject()
})

test('approveSignTransaction rejects an expired covered decision before signing', async () => {
  const sign = vi.fn(async (_m: Uint8Array) => new Uint8Array(64))
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'expired',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      decisionReason: 'eligible' as const,
      decisionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  })
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('Cover decision expired')

  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('rejects transaction bytes changed after the Ember decision', async () => {
  const sign = vi.fn(async () => new Uint8Array(64).fill(7))
  const postSign = vi.fn(async () => {})
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'decision_exact_bytes',
      coverStatus: 'covered',
      riskBand: 'low',
      decisionReason: 'eligible',
      decisionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    postSign,
  })
  const input = transactionInput()
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [input])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  input.transaction[0] = (input.transaction[0] ?? 0) ^ 1

  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow(
    'Signing bytes changed after Ember review',
  )
  expect(sign).not.toHaveBeenCalled()
  expect(postSign).not.toHaveBeenCalled()
  svc.reject()
})

test('a malformed signTransaction resolves to an explicit unavailable terminal state', async () => {
  const cover = coverProvider({
    preSign: async () => {
      throw new Error('should not be called with malformed input')
    },
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [
    { account: ACCOUNT, chain: SOLANA_DEVNET_CHAIN, transaction: null } as never,
  ])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('unavailable'))
  expect(svc.get()?.coverChecking).toBe(false)
  expect(svc.get()?.cover?.debug).toMatchObject({
    stage: 'provider_error',
    apiAttempted: false,
  })
})

test('never leaks the decision reason into the approval view', async () => {
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      decisionReason: 'eligible' as const,
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  void svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.cover).toBeDefined())
  const view = svc.get()
  expect(view?.cover).not.toHaveProperty('decisionReason')
})

test('zero remaining cap on a covered decision stays covered and posts evidence', async () => {
  const postSign = vi.fn(async () => {})
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'r',
      coverStatus: 'covered' as const,
      riskBand: 'low' as const,
      decisionReason: 'eligible' as const,
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
      capContext: { remainingCoveredTxThisMonth: 0 },
      coveredTxCountImpact: 1,
    }),
    postSign,
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await svc.approveSignTransaction(undefined, consent(svc))
  await pending

  expect(postSign).toHaveBeenCalledOnce()
  const postSignArgs = postSign.mock.calls[0] as unknown as [{ signature?: string }] | undefined
  expect(postSignArgs?.[0]?.signature).toBeTruthy()
  const records = await storage.getItem<Array<{ coverStatus: string; signature: string }>>('local:ember-cover-records')
  expect(records?.[0]?.coverStatus).toBe('covered')
  expect(records?.[0]?.signature).toBeTruthy()
})

test('does not release signed transaction bytes until evidence persistence completes', async () => {
  let releaseEvidence = () => {}
  const evidenceGate = new Promise<void>((resolve) => {
    releaseEvidence = resolve
  })
  const postSign = vi.fn(async () => {
    await evidenceGate
  })
  const cover = coverProvider({
    preSign: async () => ({
      requestId: 'decision_durable_first',
      coverStatus: 'covered',
      riskBand: 'low',
      decisionReason: 'eligible',
      decisionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    postSign,
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  let dappResolved = false
  const pending = svc.create('signTransaction', [transactionInput()]).then((value) => {
    dappResolved = true
    return value
  })
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  const approval = svc.approveSignTransaction(undefined, consent(svc))
  await vi.waitFor(() => expect(postSign).toHaveBeenCalledOnce())
  expect(dappResolved).toBe(false)

  releaseEvidence()
  await approval
  await pending
  expect(dappResolved).toBe(true)
})


test('exhausted cap is not covered and skips post sign evidence', async () => {
  const postSign = vi.fn(async () => {})
  const cover = coverProvider({
    preSign: async () => ({
      requestId: '',
      coverStatus: 'not_covered' as const,
      riskBand: 'severe' as const,
      decisionReason: 'coverage_limit_reached' as const,
      decisionExpiresAt: new Date(0).toISOString(),
      capContext: { remainingCoveredTxThisMonth: 0 },
      coveredTxCountImpact: 0,
    }),
    postSign,
  })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('not_covered'))

  await svc.approveSignTransaction(undefined, consent(svc))
  await pending

  expect(postSign).not.toHaveBeenCalled()
  // The verdict is still recorded locally — epoch-expiry (not_enrolled/exhausted) decisions
  // must show "not covered" in Activity, so recording is NOT gated on freshness.
  const records = await storage.getItem<Array<{ coverStatus: string }>>('local:ember-cover-records')
  expect(records?.[0]?.coverStatus).toBe('not_covered')
})

test('a failed dapp simulation blocks signing and exposes its result without issuing cover', async () => {
  const sign = vi.fn(signer.sign)
  const preSign = vi.fn(coverProvider({}).preSign)
  vi.mocked(preflightTransaction).mockResolvedValue({ status: 'blocked', reason: 'simulation_failed', message: 'Simulation failed: insufficient lamports' })
  const svc = new RequestService({ ...signer, sign }, coverProvider({ preSign }))
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.transactionPreflight?.status).toBe('blocked'))
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('insufficient lamports')
  expect(sign).not.toHaveBeenCalled()
  expect(preSign).not.toHaveBeenCalled()
  svc.reject()
})

test('a blockhash expiring after review cannot be signed even with cover', async () => {
  const sign = vi.fn(signer.sign)
  vi.mocked(preflightTransaction)
    .mockResolvedValueOnce({ status: 'valid' })
    .mockResolvedValueOnce({ status: 'blocked', reason: 'expired', message: 'Blockhash expired. Cancel and start again from the app.' })
  const cover = coverProvider({ preSign: async () => ({ requestId: 'decision-test', coverStatus: 'covered', riskBand: 'low', decisionReason: 'eligible', decisionExpiresAt: new Date(Date.now() + 60000).toISOString() }) })
  const svc = new RequestService({ ...signer, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('Blockhash expired')
  expect(svc.get()?.transactionPreflight).toMatchObject({ status: 'blocked', reason: 'expired' })
  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('retrying validation after funding can proceed without changing dapp transaction bytes', async () => {
  const sign = vi.fn(signer.sign)
  vi.mocked(preflightTransaction).mockResolvedValueOnce({ status: 'blocked', reason: 'simulation_failed', message: 'Insufficient lamports' })
  const svc = new RequestService({ ...signer, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const input = transactionInput()
  const pending = svc.create('signTransaction', [input])
  await vi.waitFor(() => expect(svc.get()?.transactionPreflight?.status).toBe('blocked'))
  await svc.refreshCover()
  expect(svc.get()?.transactionPreflight).toEqual({ status: 'valid' })
  await svc.approveSignTransaction(undefined, consent(svc))
  await pending
  expect(sign).toHaveBeenCalledOnce()
  expect(preflightTransaction).toHaveBeenLastCalledWith(input.transaction, 'devnet')
})

test('concurrent dapp confirmations do not sign twice during final validation', async () => {
  const sign = vi.fn(signer.sign)
  const svc = new RequestService({ ...signer, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.coverChecking).toBe(false))
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.mocked(preflightTransaction).mockImplementationOnce(async () => { await gate; return { status: 'valid' } })
  const first = svc.approveSignTransaction(undefined, consent(svc))
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('already in progress')
  release()
  await first
  await pending
  expect(sign).toHaveBeenCalledOnce()
})

test('rejecting an unsigned covered request releases its server reservation', async () => {
  const cancelReview = vi.fn(async () => {})
  const cover = coverProvider({ cancelReview, preSign: async () => ({ requestId: 'decision_cancel', coverStatus: 'covered', riskBand: 'low', decisionReason: 'eligible', decisionExpiresAt: new Date(Date.now() + 60000).toISOString() }) })
  const svc = new RequestService(signer, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 9 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))
  svc.reject()
  await expect(pending).rejects.toThrow('rejected')
  expect(cancelReview).toHaveBeenCalledWith('decision_cancel')
})

test('a signer error cannot trigger a second signing attempt for the same review', async () => {
  const sign = vi.fn(async () => { throw new Error('signer interrupted') })
  const svc = new RequestService({ getAddress: signer.getAddress, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 12 } as never)
  void svc.create('signTransaction', [transactionInput()]).catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.coverChecking).toBe(false))
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('signer interrupted')
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('No signTransaction request')
  expect(svc.get()).toBeNull()
  expect(sign).toHaveBeenCalledOnce()
})

test('storage failure after signing retries the retained transaction without signing again', async () => {
  const sign = vi.fn(signer.sign)
  const postSign = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined)
  const cover = coverProvider({
    preSign: async () => ({ requestId: 'audit-decision', coverStatus: 'covered', riskBand: 'low', decisionReason: 'eligible', decisionExpiresAt: new Date(Date.now() + 60000).toISOString() }),
    postSign,
  })
  const svc = new RequestService({ ...signer, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  let settled = false
  void svc.create('signTransaction', [transactionInput()]).then(() => { settled = true }, () => { settled = true })
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('Retry saving')
  expect(sign).toHaveBeenCalledOnce()
  expect(svc.get()?.signingStarted).toBe(true)
  expect(settled).toBe(false)
  expect(() => svc.reject()).toThrow('Signing has started')
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow()
  await expect(svc.create('connect', undefined)).rejects.toThrow('already exists')
  const id = svc.get()!.id
  expect(svc.get()?.recoveryRequired).toBe(true)
  await svc.retrySigned(id)
  expect(settled).toBe(true)
  expect(sign).toHaveBeenCalledOnce()
  expect(postSign).toHaveBeenCalledTimes(2)
  expect(postSign.mock.calls[0]?.[0].signedBytes).toBe(postSign.mock.calls[1]?.[0].signedBytes)
  expect(svc.get()).toBeNull()
})

test('message persistence recovery never repeats the signature', async () => {
  const sign = vi.fn(signer.sign)
  const postSignMessage = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined)
  const cover = coverProvider({
    preSignMessage: async () => ({ requestId: 'message-recovery', coverStatus: 'unsupported', riskBand: 'high', decisionReason: 'unsupported', decisionExpiresAt: new Date(Date.now() + 60000).toISOString() }),
    postSignMessage,
  })
  const svc = new RequestService({ ...signer, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 42 } as never)
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: new Uint8Array([1, 2, 3]) }])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('unsupported'))
  await expect(svc.approveSignMessage(undefined, consent(svc))).rejects.toThrow('Retry saving')
  fakeBrowser.windows.onRemoved.trigger(42)
  expect(svc.get()?.recoveryRequired).toBe(true)
  await svc.retrySigned(svc.get()!.id)
  expect((await pending)[0]?.signature).toHaveLength(64)
  expect(sign).toHaveBeenCalledOnce()
  expect(postSignMessage.mock.calls[0]?.[0].signature).toBe(postSignMessage.mock.calls[1]?.[0].signature)
  expect(svc.get()).toBeNull()
})

test.each(['signTransaction', 'signMessage'] as const)('direct %s calls cannot bypass a danger block even with every acknowledgement', async (kind) => {
  const sign = vi.fn(signer.sign)
  const decision = {
    requestId: 'danger-review', coverStatus: 'not_covered' as const, riskBand: 'severe' as const,
    decisionReason: 'not_eligible' as const, decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    signingDisposition: { status: 'block' as const, reason: 'authority_handover' as const },
  }
  const cover = coverProvider({ preSign: async () => decision, preSignMessage: async () => decision })
  const svc = new RequestService({ ...signer, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = kind === 'signTransaction' ? svc.create(kind, [transactionInput()]) : svc.create(kind, [{ account: ACCOUNT, message: new TextEncoder().encode('hello') }])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  const approve = () => kind === 'signTransaction' ? svc.approveSignTransaction(undefined, consent(svc)) : svc.approveSignMessage(undefined, consent(svc))
  await expect(approve()).rejects.toThrow('Signing blocked')
  // A failed later provider call cannot erase an already identified danger.
  cover.preSign = async () => { throw new Error('offline') }
  cover.preSignMessage = async () => { throw new Error('offline') }
  await svc.refreshCover()
  await expect(approve()).rejects.toThrow('Signing blocked')
  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test.each(['coverage', 'effects', 'safety'] as const)('background enforces the %s acknowledgement for an uncertain uncovered transaction', async (missing) => {
  const sign = vi.fn(signer.sign)
  const svc = new RequestService({ ...signer, sign }, coverProvider({}))
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  await expect(svc.approveSignTransaction()).rejects.toThrow('review changed')
  const accepted = consent(svc)
  await expect(svc.approveSignTransaction(undefined, { ...accepted, acknowledged: accepted.acknowledged.filter(value => value !== missing) })).rejects.toThrow('acknowledgements are missing')
  expect(sign).not.toHaveBeenCalled()
  await svc.approveSignTransaction(undefined, accepted)
  await pending
  expect(sign).toHaveBeenCalledOnce()
})

test('background enforces message-risk acknowledgement independently of the approval UI', async () => {
  const sign = vi.fn(signer.sign)
  const svc = new RequestService({ ...signer, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signMessage', [{ account: ACCOUNT, message: new TextEncoder().encode('Authorize token access') }])
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  const accepted = consent(svc)
  await expect(svc.approveSignMessage(undefined, { ...accepted, acknowledged: accepted.acknowledged.filter(value => value !== 'message') })).rejects.toThrow('acknowledgements are missing')
  expect(sign).not.toHaveBeenCalled()
  await svc.approveSignMessage(undefined, accepted)
  await pending
})

test('refresh invalidates earlier consent even when the displayed warning stays the same', async () => {
  const sign = vi.fn(signer.sign)
  const svc = new RequestService({ ...signer, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  const old = consent(svc)
  await svc.refreshCover()
  await expect(svc.approveSignTransaction(undefined, old)).rejects.toThrow('review changed')
  expect(sign).not.toHaveBeenCalled()
  await svc.approveSignTransaction(undefined, consent(svc))
  await pending
})

test.each(['bytes', 'chain', 'wallet'] as const)('review remains bound to %s even without a cover provider', async (change) => {
  const sign = vi.fn(signer.sign)
  let wallet = FEE_PAYER
  const svc = new RequestService({ getAddress: async () => wallet, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const input = transactionInput()
  const pending = svc.create('signTransaction', [input])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  const accepted = consent(svc)
  if (change === 'bytes') input.transaction[0] = input.transaction[0]! ^ 1
  if (change === 'chain') Object.defineProperty(input, 'chain', { value: 'solana:mainnet' })
  if (change === 'wallet') wallet = '11111111111111111111111111111111'
  await expect(svc.approveSignTransaction(undefined, accepted)).rejects.toThrow(/changed/)
  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('an uncovered review cannot be signed after its assessment expires', async () => {
  const sign = vi.fn(signer.sign)
  const expiresAt = Date.now() + 60000
  const svc = new RequestService({ ...signer, sign }, coverProvider({ preSign: async () => ({
    requestId: 'uncovered-review', coverStatus: 'not_covered', riskBand: 'low', decisionReason: 'not_eligible',
    decisionExpiresAt: new Date(expiresAt).toISOString(), signingDisposition: { status: 'acknowledge', reason: 'without_coverage' },
  }) }))
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  const accepted = consent(svc)
  vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
  await expect(svc.approveSignTransaction(undefined, accepted)).rejects.toThrow('Signing review expired')
  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('a review refreshed during final preflight invalidates consent before custody', async () => {
  const sign = vi.fn(signer.sign)
  const svc = new RequestService({ ...signer, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  const accepted = consent(svc)
  vi.mocked(preflightTransaction).mockImplementationOnce(async () => {
    await svc.refreshCover()
    return { status: 'valid' }
  })
  await expect(svc.approveSignTransaction(undefined, accepted)).rejects.toThrow('review changed')
  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})


test.each(['absent', 'unavailable', 'allow'] as const)('locally blocks padded unlimited approval when backend is %s', async (mode) => {
  const sign = vi.fn(signer.sign)
  const provider = mode === 'absent' ? undefined : coverProvider({ preSign: async () => ({
    requestId: '', decisionReason: 'temporarily_unavailable', decisionExpiresAt: new Date(0).toISOString(),
    coverStatus: 'unavailable', riskBand: 'low', signingDisposition: mode === 'allow' ? { status: 'allow' } : null,
  }) })
  const svc = new RequestService({ ...signer, sign }, provider)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const message = pipe(createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(toAddress(FEE_PAYER), m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: toBlockhash('11111111111111111111111111111111'), lastValidBlockHeight: 0n }, m),
    m => appendTransactionMessageInstruction({ programAddress: toAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      accounts: [
        { address: toAddress('11111111111111111111111111111111'), role: AccountRole.WRITABLE },
        { address: toAddress('11111111111111111111111111111112'), role: AccountRole.READONLY },
        { address: toAddress(FEE_PAYER), role: AccountRole.READONLY_SIGNER },
      ], data: Uint8Array.from([4, ...Array<number>(8).fill(255), 0]),
    }, m))
  const input = { ...transactionInput(), transaction: new Uint8Array(getTransactionEncoder().encode(compileTransaction(message))) }
  const pending = svc.create('signTransaction', [input])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.signingReview?.disposition.status).toBe('block'))
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('unlimited token access')
  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})

test('a CPI veto discovered at final preflight remains blocked after a later clean retry', async () => {
  const sign = vi.fn(signer.sign)
  const svc = new RequestService({ ...signer, sign })
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.signingReview).toBeDefined())
  vi.mocked(preflightTransaction).mockResolvedValueOnce({
    status: 'blocked', reason: 'dangerous_effects', message: 'Signing blocked: unlimited token access',
    disposition: { status: 'block', reason: 'unlimited_token_access' },
  })
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('Signing blocked')
  await svc.refreshCover()
  expect(svc.get()?.signingReview?.disposition.status).toBe('block')
  await expect(svc.approveSignTransaction(undefined, consent(svc))).rejects.toThrow('unlimited token access')
  expect(sign).not.toHaveBeenCalled()
  svc.reject()
})
