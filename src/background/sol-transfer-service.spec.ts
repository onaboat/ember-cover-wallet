import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test, vi } from 'vitest'

import { base58Encode } from '../cover/ember-auth.ts'
import { maxSolSendLamports, parseSolAmountToLamports, WalletTransferProvider } from './sol-transfer-service.ts'

const SOURCE = base58Encode(new Uint8Array(32).fill(1))
const DESTINATION = base58Encode(new Uint8Array(32).fill(2))
const BLOCKHASH = '11111111111111111111111111111111'

beforeEach(() => {
  fakeBrowser.reset()
})

function rpcStub(options: { simulationError?: unknown } = {}) {
  return {
    getBalance: () => ({
      send: async () => ({ value: 2_000_000_000n }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1n } }),
    }),
    simulateTransaction: () => ({
      send: async () => ({ value: { err: options.simulationError ?? null, fee: 5_000n, logs: [] } }),
    }),
    sendTransaction: () => ({
      send: async () => 'submitted-signature' as never,
    }),
  }
}

function signerStub() {
  return {
    getAddress: async () => SOURCE,
    sign: vi.fn(async (_message: Uint8Array) => new Uint8Array(64).fill(1)),
  }
}

function coverStub(
  status: 'covered' | 'not_covered' | 'unavailable' = 'covered',
  options: {
    capContext?: { monthlyLossCapUsd?: number; remainingCoveredTxThisMonth: number }
    coveredTxCountImpact?: number
    expiresAt?: string
    reasonCodes?: string[]
    riskBand?: 'low' | 'medium' | 'high' | 'severe'
  } = {},
) {
  return {
    preSign: vi.fn(async () => ({
      requestId: status === 'covered' ? 'cover-request' : '',
      coverStatus: status,
      riskBand: options.riskBand ?? 'low',
      reasonCodes: options.reasonCodes ?? [],
      decisionExpiresAt: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
      ...(options.capContext === undefined ? {} : { capContext: options.capContext }),
      ...(options.coveredTxCountImpact === undefined ? {} : { coveredTxCountImpact: options.coveredTxCountImpact }),
    })),
    postSign: vi.fn(async () => {}),
    status: vi.fn(async () => null),
    preSignMessage: vi.fn(async () => ({
      requestId: '',
      coverStatus: 'unavailable' as const,
      riskBand: 'severe' as const,
      reasonCodes: [],
      decisionExpiresAt: new Date(0).toISOString(),
    })),
    postSignMessage: vi.fn(async () => {}),
    enroll: async () => true,
    authorizeSession: async () => true,
    registerWithApi: async () => true,
    isEnrolled: async () => true,
  }
}

test('parses SOL amounts to lamports', () => {
  expect(parseSolAmountToLamports('1')).toBe(1_000_000_000n)
  expect(parseSolAmountToLamports('0.000000001')).toBe(1n)
  expect(() => parseSolAmountToLamports('0.0000000001')).toThrow('9 decimal')
  expect(() => parseSolAmountToLamports('0')).toThrow('greater than 0')
})

test('calculates fee-aware SOL max', () => {
  expect(maxSolSendLamports(5_000n)).toBe(0n)
  expect(maxSolSendLamports(5_001n)).toBe(1n)
})

test('preview shows cover and estimated debits', async () => {
  const provider = new WalletTransferProvider(
    signerStub(),
    coverStub('covered', {
      capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
      coveredTxCountImpact: 1,
    }),
    { rpcFactory: () => rpcStub() },
  )

  const preview = await provider.previewSolTransfer({ amountSol: '0.25', destination: DESTINATION })

  expect(preview.cover.label).toBe('Covered')
  expect(preview.cover.capContext).toEqual({ monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 })
  expect(preview.cover.coveredTxCountImpact).toBe(1)
  expect(preview.amountSol).toBe('0.25')
  expect(preview.feeSol).toBe('0.000005')
  expect(preview.totalDebitSol).toBe('0.250005')
  expect(preview.balanceAfterSol).toBe('1.749995')
})

test('preview uses the requested wallet cluster', async () => {
  let requestedCluster = ''
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: (cluster) => {
      requestedCluster = cluster
      return rpcStub()
    },
  })

  await provider.previewSolTransfer({ amountSol: '0.25', cluster: 'mainnet-beta', destination: DESTINATION })

  expect(requestedCluster).toBe('mainnet-beta')
})

test('not covered sends require acknowledgement before signing', async () => {
  const signer = signerStub()
  const provider = new WalletTransferProvider(signer, coverStub('not_covered'), { rpcFactory: () => rpcStub() })

  await expect(provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION })).rejects.toThrow(
    'not covered',
  )

  expect(signer.sign).not.toHaveBeenCalled()
})

test('high risk covered sends require acknowledgement before signing', async () => {
  const signer = signerStub()
  const provider = new WalletTransferProvider(signer, coverStub('covered', { riskBand: 'high' }), {
    rpcFactory: () => rpcStub(),
  })

  await expect(provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION })).rejects.toThrow(
    'high risk',
  )

  expect(signer.sign).not.toHaveBeenCalled()
})

test('expired covered sends are rejected before signing', async () => {
  const signer = signerStub()
  const provider = new WalletTransferProvider(signer, coverStub('covered', { expiresAt: new Date(0).toISOString() }), {
    rpcFactory: () => rpcStub(),
  })

  await expect(
    provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION, acknowledgeHighRisk: true }),
  ).rejects.toThrow('expired')

  expect(signer.sign).not.toHaveBeenCalled()
})

test('invalid recipient addresses fail with user-facing copy', async () => {
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), { rpcFactory: () => rpcStub() })

  await expect(provider.previewSolTransfer({ amountSol: '0.25', destination: 'not-an-address' })).rejects.toThrow(
    'valid Solana address',
  )
})

test('covered sends sign, broadcast, and post sign evidence', async () => {
  const signer = signerStub()
  const cover = coverStub('covered')
  const provider = new WalletTransferProvider(signer, cover, { rpcFactory: () => rpcStub() })

  const result = await provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION })

  expect(result.signature).toBeTruthy()
  expect(result.cover.coverStatus).toBe('covered')
  expect(signer.sign).toHaveBeenCalledOnce()
  expect(cover.postSign).toHaveBeenCalledOnce()
})

test('records the cover verdict locally so the in-wallet send shows its status in Activity', async () => {
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), { rpcFactory: () => rpcStub() })

  const result = await provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION })

  const records = await storage.getItem<Array<{ signature: string; coverStatus: string; walletAddress: string }>>(
    'local:ember-cover-records',
  )
  expect(records?.[0]?.signature).toBe(result.signature)
  expect(records?.[0]?.coverStatus).toBe('covered')
  expect(records?.[0]?.walletAddress).toBe(SOURCE)
})

test('zero remaining cap on a covered send stays covered and posts sign evidence', async () => {
  const signer = signerStub()
  const cover = coverStub('covered', { capContext: { remainingCoveredTxThisMonth: 0 }, coveredTxCountImpact: 1 })
  const provider = new WalletTransferProvider(signer, cover, { rpcFactory: () => rpcStub() })

  const preview = await provider.previewSolTransfer({ amountSol: '0.25', destination: DESTINATION })
  expect(preview.cover.coverStatus).toBe('covered')
  expect(preview.cover.body).toBe('Ember Cover is available for this send.')

  await provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION })

  expect(cover.postSign).toHaveBeenCalledOnce()
})

test('exhausted cap makes a send not covered and skips post sign evidence', async () => {
  const signer = signerStub()
  const cover = coverStub('not_covered', {
    capContext: { remainingCoveredTxThisMonth: 0 },
    coveredTxCountImpact: 0,
    reasonCodes: ['transaction_count_exhausted'],
    riskBand: 'severe',
  })
  const provider = new WalletTransferProvider(signer, cover, { rpcFactory: () => rpcStub() })

  const preview = await provider.previewSolTransfer({ amountSol: '0.25', destination: DESTINATION })
  expect(preview.cover.coverStatus).toBe('not_covered')
  expect(preview.cover.body).toBe('No Ember Cover checks left this month.')

  await provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION, acknowledgeUncovered: true })

  expect(cover.postSign).not.toHaveBeenCalled()
})

test('simulation failures are not sent', async () => {
  const signer = signerStub()
  const provider = new WalletTransferProvider(signer, coverStub('covered'), {
    rpcFactory: () => rpcStub({ simulationError: { InstructionError: [0, 'Custom'] } }),
  })

  await expect(provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION })).rejects.toThrow(
    'Simulation failed',
  )

  expect(signer.sign).not.toHaveBeenCalled()
})
