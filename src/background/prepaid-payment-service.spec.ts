import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test, vi } from 'vitest'
import { getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit'

import { decodeTransactionSummary } from '../entrypoints/request/decode-transaction.ts'
import type { CoverStatusSnapshot } from '../cover/ember-types.ts'
import type { CoverProvider } from './cover-service.ts'
import {
  PrepaidPaymentProvider,
  type LocalPrepaidPaymentState,
  type PaymentRpcClient,
} from './prepaid-payment-service.ts'

const ADDRESS = 'So11111111111111111111111111111111111111112'
const OTHER_ADDRESS = '11111111111111111111111111111112'
const PAYMENT_KEY = 'local:ember-cover-prepaid-payment:v1'

function state(overrides: Partial<LocalPrepaidPaymentState> = {}): LocalPrepaidPaymentState {
  return {
    version: 1,
    amountBaseUnits: '1000000',
    cluster: 'devnet',
    lastUpdatedAt: '2026-07-25T00:00:00.000Z',
    paymentSignature: 'signature',
    signedTransactionBase64: 'signed-transaction',
    status: 'activation_pending',
    tier: 'Core',
    tokenMint: 'mint',
    treasuryTokenAccount: 'treasury',
    walletAddress: ADDRESS,
    ...overrides,
  }
}

function confirmedRpc(): PaymentRpcClient {
  const unused = () => ({ send: async () => Promise.reject(new Error('unexpected RPC call')) })
  return {
    getBalance: unused,
    isBlockhashValid: unused,
    getLatestBlockhash: unused,
    getTokenAccountBalance: unused,
    simulateTransaction: unused,
    sendTransaction: unused,
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ confirmationStatus: 'confirmed', err: null }],
      }),
    }),
  } as unknown as PaymentRpcClient
}

const unavailable = {
  requestId: '',
  coverStatus: 'unavailable' as const,
  riskBand: 'severe' as const,
  reasonCodes: [],
  decisionExpiresAt: new Date(0).toISOString(),
}

function coverSnapshot(
  overrides: Partial<CoverStatusSnapshot> = {},
): CoverStatusSnapshot {
  return {
    subscriptionActive: true,
    subscriptionStatus: 'active',
    walletRegistered: true,
    tier: 'Core',
    month: '2026-07',
    currentPeriodEnd: '2026-08-24T00:00:00Z',
    coveredTxPerMonth: 100,
    usedCoveredTxThisMonth: 0,
    remainingCoveredTxThisMonth: 100,
    monthlyLossCapUsd: 10000,
    usedLossCapUsd: 0,
    remainingLossCapUsd: 10000,
    ...overrides,
  }
}

beforeEach(() => {
  fakeBrowser.reset()
})

test('local payment state is scoped to the active wallet', async () => {
  const provider = new PrepaidPaymentProvider({
    getAddress: async () => ADDRESS,
    sign: async () => new Uint8Array(64),
  })
  await storage.setItem(PAYMENT_KEY, state())

  expect(await provider.localPayment(ADDRESS)).toMatchObject({ walletAddress: ADDRESS })
  expect(await provider.localPayment(OTHER_ADDRESS)).toBeNull()
})

test('preview simulates one exact TransferChecked payment to the treasury', async () => {
  let simulatedTransaction = ''
  const rpc = {
    getBalance: () => ({ send: async () => ({ value: 1_000_000n }) }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1_000n,
        },
      }),
    }),
    getTokenAccountBalance: () => ({
      send: async () => ({
        value: { amount: '2000000', decimals: 6, uiAmountString: '2' },
      }),
    }),
    simulateTransaction: (transaction: string) => ({
      send: async () => {
        simulatedTransaction = transaction
        return { value: { err: null, fee: 5_000n, logs: [] } }
      },
    }),
    isBlockhashValid: () => ({ send: async () => ({ value: true }) }),
    sendTransaction: () => ({ send: async () => Promise.reject(new Error('unexpected send')) }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
  } as unknown as PaymentRpcClient
  const provider = new PrepaidPaymentProvider(
    { getAddress: async () => ADDRESS, sign: async () => new Uint8Array(64) },
    undefined,
    { rpcFactory: () => rpc },
  )

  const preview = await provider.previewPayment({ cluster: 'devnet' })
  const summary = decodeTransactionSummary(new Uint8Array(Buffer.from(simulatedTransaction, 'base64')))

  expect(preview).toMatchObject({
    amountBaseUnits: '1000000',
    amountUsdc: '1',
    cluster: 'devnet',
    errors: [],
    simulation: { status: 'success' },
    treasuryTokenAccount: 'AmXrozEs535RMiwSxkjhcyuq5reC9ntvtBXCef8wCP6s',
  })
  expect(summary?.instructions).toHaveLength(1)
  expect(summary?.primaryAction).toMatchObject({
    kind: 'token_transfer',
    amount: '1 tokens',
    tokenMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    recipient: 'AmXrozEs535RMiwSxkjhcyuq5reC9ntvtBXCef8wCP6s',
    source: preview.userUsdcAta,
  })
})

test('activation signs and sends one simulated payment before activating cover', async () => {
  const calls: string[] = []
  let signedTransaction = ''
  const rpc = {
    getBalance: () => ({ send: async () => ({ value: 1_000_000n }) }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1_000n,
        },
      }),
    }),
    getTokenAccountBalance: () => ({
      send: async () => ({
        value: { amount: '2000000', decimals: 6, uiAmountString: '2' },
      }),
    }),
    simulateTransaction: () => ({
      send: async () => {
        calls.push('simulate')
        return { value: { err: null, fee: 5_000n, logs: [] } }
      },
    }),
    isBlockhashValid: () => ({ send: async () => ({ value: true }) }),
    sendTransaction: (transaction: string) => ({
      send: async () => {
        calls.push('send')
        signedTransaction = transaction
        return getSignatureFromTransaction(
          getTransactionDecoder().decode(new Uint8Array(Buffer.from(transaction, 'base64'))),
        )
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ confirmationStatus: 'confirmed', err: null }],
      }),
    }),
  } as unknown as PaymentRpcClient
  const cover: CoverProvider = {
    preSign: async () => unavailable,
    postSign: async () => {},
    status: async () => null,
    preSignMessage: async () => unavailable,
    postSignMessage: async () => {},
    enroll: async () => true,
    authorizeSession: async () => {
      calls.push('authorize')
      return true
    },
    registerWithApi: async () => true,
    isEnrolled: async () => true,
    activatePaymentEntitlement: async (request) => {
      calls.push(`activate:${request.paymentSignature}`)
      return {
        walletPublicKey: ADDRESS,
        subscriptionActive: true,
        subscriptionStatus: 'active',
        tier: 'Core',
        billingPeriod: '30_days',
        currentPeriodEnd: '2026-08-24T00:00:00Z',
        coveredTxPerMonth: 100,
        monthlyLossCapUsd: 10000,
        paymentSignature: request.paymentSignature,
      }
    },
  }
  const provider = new PrepaidPaymentProvider(
    {
      getAddress: async () => ADDRESS,
      sign: async () => {
        calls.push('sign')
        return new Uint8Array(64).fill(7)
      },
    },
    cover,
    {
      confirmationAttempts: 1,
      now: () => Date.parse('2026-07-25T00:00:00Z'),
      rpcFactory: () => rpc,
      sleep: async () => {},
    },
  )

  const result = await provider.activatePayment({ cluster: 'devnet' })

  expect(signedTransaction).not.toBe('')
  expect(calls).toEqual(['simulate', 'sign', 'send', 'authorize', `activate:${result.signature}`])
  expect(result).toMatchObject({
    apiCoverActive: true,
    state: {
      version: 2,
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: '1000',
      status: 'active',
    },
  })
})

test('sync activates a confirmed saved payment without creating another payment', async () => {
  const calls: string[] = []
  const cover: CoverProvider = {
    preSign: async () => unavailable,
    postSign: async () => {},
    status: async () => null,
    preSignMessage: async () => unavailable,
    postSignMessage: async () => {},
    enroll: async () => true,
    authorizeSession: async () => {
      calls.push('authorize')
      return true
    },
    registerWithApi: async () => {
      calls.push('unexpected-register')
      return true
    },
    isEnrolled: async () => true,
    activatePaymentEntitlement: async (request) => {
      calls.push(`activate:${request.paymentSignature}`)
      return {
        walletPublicKey: ADDRESS,
        subscriptionActive: true,
        subscriptionStatus: 'active',
        tier: 'Core',
        billingPeriod: '30_days',
        currentPeriodEnd: '2026-08-24T00:00:00Z',
        coveredTxPerMonth: 100,
        monthlyLossCapUsd: 10000,
        paymentSignature: request.paymentSignature,
      }
    },
  }
  const provider = new PrepaidPaymentProvider(
    { getAddress: async () => ADDRESS, sign: async () => new Uint8Array(64) },
    cover,
    {
      confirmationAttempts: 1,
      rpcFactory: () => confirmedRpc(),
      sleep: async () => {},
    },
  )
  await storage.setItem(PAYMENT_KEY, state())

  const result = await provider.syncPayment(ADDRESS)

  expect(calls).toEqual(['authorize', 'activate:signature'])
  expect(result).toMatchObject({
    apiCoverActive: true,
    state: {
      status: 'active',
      currentPeriodEnd: '2026-08-24T00:00:00Z',
    },
  })
})

test('sync retires an unconfirmed payment after its blockhash expires', async () => {
  const sendTransaction = vi.fn()
  const unused = () => ({ send: async () => Promise.reject(new Error('unexpected RPC call')) })
  const rpc = {
    getBalance: unused,
    getLatestBlockhash: unused,
    getTokenAccountBalance: unused,
    simulateTransaction: unused,
    sendTransaction,
    getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
    isBlockhashValid: () => ({ send: async () => ({ value: false }) }),
  } as unknown as PaymentRpcClient
  const provider = new PrepaidPaymentProvider(
    { getAddress: async () => ADDRESS, sign: async () => new Uint8Array(64) },
    undefined,
    {
      confirmationAttempts: 1,
      rpcFactory: () => rpc,
      sleep: async () => {},
    },
  )
  await storage.setItem(
    PAYMENT_KEY,
    state({
      version: 2,
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: '1000',
      status: 'confirmation_pending',
    }),
  )

  const result = await provider.syncPayment(ADDRESS)

  expect(sendTransaction).not.toHaveBeenCalled()
  expect(result).toMatchObject({
    apiCoverActive: false,
    state: { status: 'expired_unconfirmed' },
  })
})

test('active local state becomes renewable only when the live cover period is expired', async () => {
  const cover: CoverProvider = {
    preSign: async () => unavailable,
    postSign: async () => {},
    status: async () =>
      coverSnapshot({
        subscriptionActive: false,
        subscriptionStatus: 'expired',
        currentPeriodEnd: '2026-07-24T00:00:00Z',
      }),
    preSignMessage: async () => unavailable,
    postSignMessage: async () => {},
    enroll: async () => true,
    authorizeSession: async () => true,
    registerWithApi: async () => true,
    isEnrolled: async () => true,
  }
  const rpcFactory = vi.fn()
  const provider = new PrepaidPaymentProvider(
    { getAddress: async () => ADDRESS, sign: async () => new Uint8Array(64) },
    cover,
    {
      now: () => Date.parse('2026-07-25T00:00:00Z'),
      rpcFactory,
    },
  )
  await storage.setItem(
    PAYMENT_KEY,
    state({
      status: 'active',
      currentPeriodEnd: '2026-07-24T00:00:00Z',
    }),
  )

  const result = await provider.syncPayment(ADDRESS)

  expect(rpcFactory).not.toHaveBeenCalled()
  expect(result).toMatchObject({
    apiCoverActive: false,
    activationError: 'Cover has expired. Review a new one-off payment to renew.',
  })
})

test('a pending saved payment blocks a second payment approval', async () => {
  const rpcFactory = vi.fn()
  const provider = new PrepaidPaymentProvider(
    { getAddress: async () => ADDRESS, sign: async () => new Uint8Array(64) },
    undefined,
    { rpcFactory },
  )
  await storage.setItem(PAYMENT_KEY, state({ status: 'confirmation_pending' }))

  await expect(provider.activatePayment({ cluster: 'devnet' })).rejects.toThrow(
    'A saved payment still needs recovery',
  )
  expect(rpcFactory).not.toHaveBeenCalled()
})
