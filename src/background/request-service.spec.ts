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
import { SOLANA_DEVNET_CHAIN } from '@solana/wallet-standard-chains'
import type { SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
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
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction()
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
  await expect(svc.approveSignTransaction()).rejects.toThrow('Multiple transaction signing is not supported')
  svc.reject()
})

test('approve closes the one-purpose approval window', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const remove = vi.spyOn(fakeBrowser.windows, 'remove').mockResolvedValue(undefined as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction()
  await pending
  expect(remove).toHaveBeenCalledWith(1)
})

test('the pending slot is cleared before the approval window closes', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction()
  await pending
  expect(svc.get()).toBeNull()
})

test('the approval-window removal event after approve does not settle the promise a second time', async () => {
  const svc = new RequestService(signer)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 7 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()).not.toBeNull())
  await svc.approveSignTransaction()
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
  await svc.approveSignTransaction(currentId)
  const [out] = await pending
  expect(out?.signedTransaction).toBeDefined()
})

test('closing the window mid-sign cancels: no signature to the dapp, no post-sign, no record', async () => {
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
      reasonCodes: [],
      decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    postSign,
  })
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 7 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  const approveP = svc.approveSignTransaction()
  approveP.catch(() => {})
  // The user closes the window while the vault signer is still in flight.
  await vi.waitFor(() => expect(sign).toHaveBeenCalled())
  fakeBrowser.windows.onRemoved.trigger(7)
  releaseSign()

  await expect(pending).rejects.toThrow('closed')
  await approveP.catch(() => {})
  // A cancelled request must not send evidence or write a local record.
  expect(postSign).not.toHaveBeenCalled()
  const records = await storage.getItem<unknown[]>('local:ember-cover-records')
  expect(records ?? []).toHaveLength(0)
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
        reasonCodes: [],
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
      reasonCodes: [],
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

  await expect(svc.approveSignTransaction()).rejects.toThrow('Cover check is still in progress')
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
      reasonCodes: [],
      decisionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  })
  const svc = new RequestService({ getAddress: signer.getAddress, sign }, cover)
  vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 1 } as never)
  const pending = svc.create('signTransaction', [transactionInput()])
  pending.catch(() => {})
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await expect(svc.approveSignTransaction()).rejects.toThrow('Cover decision expired')

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
      reasonCodes: [],
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

  await expect(svc.approveSignTransaction()).rejects.toThrow(
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
  void svc.create('signTransaction', [transactionInput()])
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
  const pending = svc.create('signTransaction', [transactionInput()])
  await vi.waitFor(() => expect(svc.get()?.cover?.coverStatus).toBe('covered'))

  await svc.approveSignTransaction()
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
      reasonCodes: [],
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

  const approval = svc.approveSignTransaction()
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
      reasonCodes: ['transaction_count_exhausted'],
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

  await svc.approveSignTransaction()
  await pending

  expect(postSign).not.toHaveBeenCalled()
  // The verdict is still recorded locally — epoch-expiry (not_enrolled/exhausted) decisions
  // must show "not covered" in Activity, so recording is NOT gated on freshness.
  const records = await storage.getItem<Array<{ coverStatus: string }>>('local:ember-cover-records')
  expect(records?.[0]?.coverStatus).toBe('not_covered')
})
