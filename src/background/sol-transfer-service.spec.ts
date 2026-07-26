import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test, vi } from 'vitest'
import { getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit'

import { base58Encode } from '../cover/ember-auth.ts'
import {
  maxSolSendLamports,
  parseSolAmountToLamports,
  parseTokenAmountToBaseUnits,
  WalletTransferProvider,
} from './sol-transfer-service.ts'

const SOURCE = base58Encode(new Uint8Array(32).fill(1))
const DESTINATION = base58Encode(new Uint8Array(32).fill(2))
const BLOCKHASH = '11111111111111111111111111111111'
const TOKEN_ACCOUNT = base58Encode(new Uint8Array(32).fill(3))
const TOKEN_MINT = base58Encode(new Uint8Array(32).fill(4))
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

beforeEach(() => {
  fakeBrowser.reset()
})

function rpcStub(options: { balanceLamports?: bigint; simulationError?: unknown } = {}) {
  return {
    getBalance: () => ({
      send: async () => ({ value: options.balanceLamports ?? 2_000_000_000n }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1n } }),
    }),
    simulateTransaction: () => ({
      send: async () => ({ value: { err: options.simulationError ?? null, fee: 5_000n, logs: [] } }),
    }),
    sendTransaction: (transaction: string) => ({
      send: async () =>
        getSignatureFromTransaction(
          getTransactionDecoder().decode(
            Uint8Array.from(atob(transaction), (character) => character.charCodeAt(0)),
          ),
        ) as never,
    }),
  }
}

function parsedTokenAccount(args: {
  mint?: string
  owner?: string
  programId?: string
  state?: string
  amount?: string
  decimals?: number
}) {
  return {
    owner: args.programId ?? TOKEN_PROGRAM,
    data: {
      parsed: {
        type: 'account',
        info: {
          mint: args.mint ?? TOKEN_MINT,
          owner: args.owner ?? SOURCE,
          state: args.state ?? 'initialized',
          tokenAmount: {
            amount: args.amount ?? '2500000',
            decimals: args.decimals ?? 6,
          },
        },
      },
    },
  }
}

function parsedMint(args: {
  programId?: string
  decimals?: number
  extensions?: readonly unknown[]
} = {}) {
  return {
    owner: args.programId ?? TOKEN_PROGRAM,
    data: {
      parsed: {
        type: 'mint',
        info: {
          decimals: args.decimals ?? 6,
          extensions: args.extensions ?? [],
        },
      },
    },
  }
}

function accountSizeReturnData(size: bigint, programId = TOKEN_2022_PROGRAM) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, size, true)
  return {
    data: [btoa(String.fromCharCode(...bytes)), 'base64'] as const,
    programId,
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

test('parses token amounts using the selected mint decimals', () => {
  expect(parseTokenAmountToBaseUnits('1.25', 6)).toBe(1_250_000n)
  expect(() => parseTokenAmountToBaseUnits('1.0000001', 6)).toThrow('6 decimal')
  expect(() => parseTokenAmountToBaseUnits('0', 6)).toThrow('greater than 0')
})

test('previews an SPL token transfer and recipient account creation without signing', async () => {
  const signer = signerStub()
  let requestedRentSize = 0
  const provider = new WalletTransferProvider(signer, coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      getAccountInfo: (account) => ({
        send: async () => ({
          value: account === TOKEN_ACCOUNT ? parsedTokenAccount({}) : account === TOKEN_MINT ? parsedMint() : null,
        }),
      }),
      getMinimumBalanceForRentExemption: (size) => ({
        send: async () => {
          requestedRentSize = Number(size)
          return 2_039_280n
        },
      }),
    }),
  })

  const preview = await provider.previewTransfer({
    amount: '1.25',
    asset: {
      kind: 'token',
      symbol: 'USDC',
      mint: TOKEN_MINT,
      tokenAccount: TOKEN_ACCOUNT,
      programId: TOKEN_PROGRAM,
      decimals: 6,
      rawBalance: '2500000',
    },
    destination: DESTINATION,
  })

  expect(preview.asset.kind).toBe('token')
  expect(preview.amountBaseUnits).toBe('1250000')
  expect(preview.tokenBalanceAfter).toBe('1.25')
  expect(preview.createsDestinationTokenAccount).toBe(true)
  expect(preview.accountRentLamports).toBe('2039280')
  expect(preview.tokenAccountSize).toBe(165)
  expect(requestedRentSize).toBe(165)
  expect(preview.simulation.status).toBe('success')
  expect(signer.sign).not.toHaveBeenCalled()
})

test('uses the Token-2022 program-reported account size for missing recipient accounts', async () => {
  let requestedRentSize = 0
  let simulations = 0
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      getAccountInfo: (account) => ({
        send: async () => ({
          value:
            account === TOKEN_ACCOUNT
              ? parsedTokenAccount({ programId: TOKEN_2022_PROGRAM })
              : account === TOKEN_MINT
                ? parsedMint({ programId: TOKEN_2022_PROGRAM })
                : null,
        }),
      }),
      getMinimumBalanceForRentExemption: (size) => ({
        send: async () => {
          requestedRentSize = Number(size)
          return 3_000_000n
        },
      }),
      simulateTransaction: () => ({
        send: async () => {
          simulations += 1
          return {
            value:
              simulations === 1
                ? { err: null, fee: 5_000n, logs: [], returnData: accountSizeReturnData(233n) }
                : { err: null, fee: 5_000n, logs: [] },
          }
        },
      }),
    }),
  })

  const preview = await provider.previewTransfer({
    amount: '1',
    asset: {
      kind: 'token',
      symbol: 'T22',
      mint: TOKEN_MINT,
      tokenAccount: TOKEN_ACCOUNT,
      programId: TOKEN_2022_PROGRAM,
      decimals: 6,
      rawBalance: '2500000',
    },
    destination: DESTINATION,
  })

  expect(preview.createsDestinationTokenAccount).toBe(true)
  expect(preview.tokenAccountSize).toBe(233)
  expect(preview.accountRentLamports).toBe('3000000')
  expect(requestedRentSize).toBe(233)
  expect(simulations).toBe(2)
})

test('does not charge recipient account rent when the correct token account already exists', async () => {
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      getAccountInfo: (account) => ({
        send: async () => ({
          value:
            account === TOKEN_ACCOUNT
              ? parsedTokenAccount({})
              : account === TOKEN_MINT
                ? parsedMint()
                : parsedTokenAccount({ owner: DESTINATION }),
        }),
      }),
      getMinimumBalanceForRentExemption: () => {
        throw new Error('rent should not be requested')
      },
    }),
  })

  const preview = await provider.previewTransfer({
    amount: '1',
    asset: {
      kind: 'token',
      symbol: 'TOK',
      mint: TOKEN_MINT,
      tokenAccount: TOKEN_ACCOUNT,
      programId: TOKEN_PROGRAM,
      decimals: 6,
      rawBalance: '2500000',
    },
    destination: DESTINATION,
  })

  expect(preview.createsDestinationTokenAccount).toBe(false)
  expect(preview.accountRentLamports).toBe('0')
  expect(preview.tokenAccountSize).toBeNull()
})

test('rejects frozen source and recipient token accounts before simulation', async () => {
  const asset = {
    kind: 'token' as const,
    symbol: 'TOK',
    mint: TOKEN_MINT,
    tokenAccount: TOKEN_ACCOUNT,
    programId: TOKEN_PROGRAM,
    decimals: 6,
    rawBalance: '2500000',
  }
  const sourceFrozen = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      getAccountInfo: (account) => ({
        send: async () => ({
          value:
            account === TOKEN_ACCOUNT
              ? parsedTokenAccount({ state: 'frozen' })
              : account === TOKEN_MINT
                ? parsedMint()
                : null,
        }),
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 2_039_280n }),
    }),
  })
  await expect(
    sourceFrozen.previewTransfer({ amount: '1', asset, destination: DESTINATION }),
  ).rejects.toThrow('selected token account is frozen')

  const recipientFrozen = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      getAccountInfo: (account) => ({
        send: async () => ({
          value:
            account === TOKEN_ACCOUNT
              ? parsedTokenAccount({})
              : account === TOKEN_MINT
                ? parsedMint()
                : parsedTokenAccount({ owner: DESTINATION, state: 'frozen' }),
        }),
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 2_039_280n }),
    }),
  })
  await expect(
    recipientFrozen.previewTransfer({ amount: '1', asset, destination: DESTINATION }),
  ).rejects.toThrow('recipient token account is frozen')
})

test('rejects destination token accounts with the wrong program or owner', async () => {
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      getAccountInfo: (account) => ({
        send: async () => ({
          value:
            account === TOKEN_ACCOUNT
              ? parsedTokenAccount({})
              : account === TOKEN_MINT
                ? parsedMint()
                : parsedTokenAccount({ owner: SOURCE, programId: TOKEN_2022_PROGRAM }),
        }),
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 2_039_280n }),
    }),
  })

  await expect(
    provider.previewTransfer({
      amount: '1',
      asset: {
        kind: 'token',
        symbol: 'TOK',
        mint: TOKEN_MINT,
        tokenAccount: TOKEN_ACCOUNT,
        programId: TOKEN_PROGRAM,
        decimals: 6,
        rawBalance: '2500000',
      },
      destination: DESTINATION,
    }),
  ).rejects.toThrow('recipient token account does not match')
})

test('rejects Token-2022 extensions that change transfer behavior', async () => {
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      getAccountInfo: (account) => ({
        send: async () => ({
          value:
            account === TOKEN_ACCOUNT
              ? parsedTokenAccount({ programId: TOKEN_2022_PROGRAM })
              : parsedMint({
                  programId: TOKEN_2022_PROGRAM,
                  extensions: [{ extension: 'transferFeeConfig' }],
                }),
        }),
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 3_000_000n }),
    }),
  })

  await expect(
    provider.previewTransfer({
      amount: '1',
      asset: {
        kind: 'token',
        symbol: 'T22',
        mint: TOKEN_MINT,
        tokenAccount: TOKEN_ACCOUNT,
        programId: TOKEN_2022_PROGRAM,
        decimals: 6,
        rawBalance: '2500000',
      },
      destination: DESTINATION,
    }),
  ).rejects.toThrow('transferFeeConfig')
})

test('reports insufficient SOL for a missing recipient token account rent', async () => {
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub({ balanceLamports: 1_000_000n }),
      getAccountInfo: (account) => ({
        send: async () => ({
          value: account === TOKEN_ACCOUNT ? parsedTokenAccount({}) : account === TOKEN_MINT ? parsedMint() : null,
        }),
      }),
      getMinimumBalanceForRentExemption: () => ({ send: async () => 2_039_280n }),
    }),
  })

  await expect(
    provider.previewTransfer({
      amount: '1',
      asset: {
        kind: 'token',
        symbol: 'TOK',
        mint: TOKEN_MINT,
        tokenAccount: TOKEN_ACCOUNT,
        programId: TOKEN_PROGRAM,
        decimals: 6,
        rawBalance: '2500000',
      },
      destination: DESTINATION,
    }),
  ).rejects.toThrow('recipient token account rent')
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

test('persists a signed wallet-owned transaction before a failed broadcast so it can retry', async () => {
  const provider = new WalletTransferProvider(signerStub(), coverStub('covered'), {
    rpcFactory: () => ({
      ...rpcStub(),
      sendTransaction: () => ({
        send: async () => {
          throw new Error('RPC unavailable')
        },
      }),
    }),
  })

  await expect(
    provider.sendSolTransfer({ amountSol: '0.25', destination: DESTINATION }),
  ).rejects.toThrow('RPC unavailable')

  const records = await storage.getItem<
    Array<{
      transactionStatus: string
      broadcastOwner: string
      signedTransactionBase64: string
      failureReason: string
    }>
  >('local:ember-cover-records')
  expect(records?.[0]).toMatchObject({
    transactionStatus: 'signed',
    broadcastOwner: 'wallet',
  })
  expect(records?.[0]?.signedTransactionBase64).toBeTruthy()
  expect(records?.[0]?.failureReason).toContain('Broadcast needs retry')
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
