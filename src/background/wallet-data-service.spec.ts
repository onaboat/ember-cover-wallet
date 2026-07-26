import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test } from 'vitest'

import type { WalletCluster } from './wallet-data-config.ts'
import { explorerTransactionUrl } from './wallet-data-config.ts'
import {
  formatLamportsAsSol,
  formatTokenAmount,
  normalizeActivity,
  normalizeTokenBalances,
  WalletDataProvider,
} from './wallet-data-service.ts'

const ADDRESS = 'So11111111111111111111111111111111111111112'

beforeEach(() => {
  fakeBrowser.reset()
})

test('defaults to devnet and stores the selected cluster', async () => {
  const provider = new WalletDataProvider()

  expect(await provider.getCluster()).toBe('devnet')

  await provider.setCluster('mainnet-beta')

  expect(await provider.getCluster()).toBe('mainnet-beta')
})

test('formats lamports as SOL without losing fractional lamports', () => {
  expect(formatLamportsAsSol(0n)).toBe('0')
  expect(formatLamportsAsSol(5_000_000_000n)).toBe('5')
  expect(formatLamportsAsSol(1_250_000_001n)).toBe('1.250000001')
})

test('formats raw token amounts with token decimals', () => {
  expect(formatTokenAmount('0', 6)).toBe('0')
  expect(formatTokenAmount('1234500', 6)).toBe('1.2345')
  expect(formatTokenAmount('10', 0)).toBe('10')
})

test('normalizes non-zero parsed token balances', () => {
  expect(
    normalizeTokenBalances([
      {
        pubkey: 'token-account-1',
        account: {
          owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          data: {
            parsed: {
              info: {
                mint: 'Mint111111111111111111111111111111111111111',
                owner: ADDRESS,
                tokenAmount: {
                  amount: '1234500',
                  decimals: 6,
                  uiAmountString: '1.2345',
                },
              },
            },
          },
        },
      },
      {
        pubkey: 'zero-token-account',
        account: {
          owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          data: {
            parsed: {
              info: {
                mint: 'Mint222222222222222222222222222222222222222',
                tokenAmount: {
                  amount: '0',
                  decimals: 6,
                },
              },
            },
          },
        },
      },
    ]),
  ).toEqual([
    {
      tokenAccount: 'token-account-1',
      mint: 'Mint111111111111111111111111111111111111111',
      owner: ADDRESS,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      rawAmount: '1234500',
      decimals: 6,
      uiAmount: '1.2345',
      label: 'Unknown Mint…1111',
      name: 'Unknown token',
      symbol: 'Mint…1111',
      iconText: '?',
      trusted: false,
    },
  ])
})

test('applies curated metadata only on the matching cluster and token program', () => {
  const account = {
    pubkey: 'usdc-account',
    account: {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: {
        parsed: {
          info: {
            mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            owner: ADDRESS,
            tokenAmount: { amount: '1000000', decimals: 6, uiAmountString: '1' },
          },
        },
      },
    },
  }

  expect(normalizeTokenBalances([account], 'devnet')[0]).toMatchObject({
    label: 'USDC',
    name: 'USD Coin',
    symbol: 'USDC',
    iconText: '$',
    trusted: true,
  })
  expect(normalizeTokenBalances([account], 'mainnet-beta')[0]).toMatchObject({
    name: 'Unknown token',
    trusted: false,
  })
})

test('normalizes activity into JSON-safe popup rows', () => {
  const activity = normalizeActivity(
    [
      {
        blockTime: 1_772_000_000n,
        confirmationStatus: 'confirmed',
        err: null,
        memo: null,
        signature: 'abc',
        slot: 470_000_000n,
      },
      {
        blockTime: null,
        confirmationStatus: null,
        err: { InstructionError: [0, 'Custom'] },
        memo: null,
        signature: 'def',
        slot: 470_000_001n,
      },
    ],
    'devnet',
  )

  expect(activity).toEqual([
    {
      signature: 'abc',
      slot: 470000000,
      blockTime: 1772000000,
      confirmationStatus: 'confirmed',
      failed: false,
      explorerUrl: explorerTransactionUrl('abc', 'devnet'),
      direction: 'unknown',
      title: 'On-chain transaction',
      amount: null,
      counterparty: null,
      feeLamports: null,
      programs: [],
    },
    {
      signature: 'def',
      slot: 470000001,
      blockTime: null,
      confirmationStatus: null,
      failed: true,
      explorerUrl: explorerTransactionUrl('def', 'devnet'),
      direction: 'unknown',
      title: 'Failed transaction',
      amount: null,
      counterparty: null,
      feeLamports: null,
      programs: [],
    },
  ])
})

test('builds a snapshot from the selected cluster RPC', async () => {
  let requestedCluster: WalletCluster | null = null
  const provider = new WalletDataProvider({
    rpcFactory: (cluster) => {
      requestedCluster = cluster
      return {
        getBalance: () => ({
          send: async () => ({ value: 5_000_000_000n }),
        }),
        getSignaturesForAddress: (_address, config) => ({
          send: async () => [
            {
              blockTime: 1_772_000_000n,
              confirmationStatus: config?.commitment ?? null,
              err: null,
              memo: null,
              signature: 'sig1',
              slot: 470_000_000n,
            },
          ],
        }),
        getTokenAccountsByOwner: () => ({
          send: async () => ({
            value: [
              {
                pubkey: 'token-account-1',
                account: {
                  owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  data: {
                    parsed: {
                      info: {
                        mint: 'Mint111111111111111111111111111111111111111',
                        owner: ADDRESS,
                        tokenAmount: {
                          amount: '1234500',
                          decimals: 6,
                          uiAmountString: '1.2345',
                        },
                      },
                    },
                  },
                },
              },
            ],
          }),
        }),
      }
    },
  })

  await provider.setCluster('mainnet-beta')
  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(requestedCluster).toBe('mainnet-beta')
  expect(snapshot).toMatchObject({
    cluster: 'mainnet-beta',
    address: ADDRESS,
    solBalance: '5',
    lamports: '5000000000',
  })
  expect(snapshot.activity).toHaveLength(1)
  expect(snapshot.tokenBalances).toHaveLength(2)
  expect(snapshot.tokenBalancesUnavailable).toBe(false)
  expect(snapshot.emberActivity).toEqual([])
  expect(snapshot.emberActivityUnavailable).toBe(false)
  expect(snapshot.activity[0]?.explorerUrl).toBe(explorerTransactionUrl('sig1', 'mainnet-beta'))
  expect(snapshot.activityUnavailable).toBe(false)
})

test('surfaces stored cover records in emberActivity, matched by signature', async () => {
  await storage.setItem('local:ember-cover-records', [
    {
      signature: 'sig1',
      walletAddress: ADDRESS,
      coverStatus: 'covered',
      riskBand: 'low',
      requestId: 'r',
      dappOrigin: null,
      recordedAt: '2026-06-21T00:00:00.000Z',
    },
  ])
  const provider = new WalletDataProvider({
    rpcFactory: () => ({
      getBalance: () => ({ send: async () => ({ value: 0n }) }),
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(snapshot.emberActivity).toHaveLength(1)
  expect(snapshot.emberActivity[0]?.signature).toBe('sig1')
  expect(snapshot.emberActivity[0]?.coverStatus).toBe('covered')
  expect(snapshot.emberActivityUnavailable).toBe(false)
})

test('moves a persisted broadcast from pending to confirmed using signature status', async () => {
  await storage.setItem('local:ember-cover-records', [
    {
      signature: 'sig-pending',
      walletAddress: ADDRESS,
      coverStatus: 'covered',
      riskBand: 'low',
      requestId: 'r',
      dappOrigin: null,
      recordedAt: '2026-07-26T00:00:00.000Z',
      cluster: 'devnet',
      transactionStatus: 'broadcast',
    },
  ])
  const provider = new WalletDataProvider({
    rpcFactory: () => ({
      getBalance: () => ({ send: async () => ({ value: 0n }) }),
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [
            {
              confirmationStatus: 'confirmed',
              err: null,
              slot: 123n,
            },
          ],
        }),
      }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(snapshot.emberActivity[0]?.onchainStatus).toBe('confirmed')
  const stored = await storage.getItem<Array<{ transactionStatus: string; lastCheckedAt: string | null }>>(
    'local:ember-cover-records',
  )
  expect(stored?.[0]?.transactionStatus).toBe('confirmed')
  expect(stored?.[0]?.lastCheckedAt).toBeTruthy()
})

test('moves a broadcast to confirmed when indexing returns it in wallet activity', async () => {
  await storage.setItem('local:ember-cover-records', [
    {
      signature: 'sig-indexed',
      walletAddress: ADDRESS,
      coverStatus: 'covered',
      recordedAt: '2026-07-26T00:00:00.000Z',
      cluster: 'devnet',
      transactionStatus: 'broadcast',
    },
  ])
  const provider = new WalletDataProvider({
    rpcFactory: () => ({
      getBalance: () => ({ send: async () => ({ value: 0n }) }),
      getSignaturesForAddress: () => ({
        send: async () => [
          {
            blockTime: 1_772_000_000n,
            confirmationStatus: 'confirmed',
            err: null,
            memo: null,
            signature: 'sig-indexed',
            slot: 123n,
          },
        ],
      }),
      getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(snapshot.activity[0]?.signature).toBe('sig-indexed')
  expect(snapshot.emberActivity[0]?.onchainStatus).toBe('confirmed')
})

test('marks an unconfirmed broadcast expired after its last valid block height', async () => {
  await storage.setItem('local:ember-cover-records', [
    {
      signature: 'sig-expired',
      walletAddress: ADDRESS,
      coverStatus: 'covered',
      recordedAt: '2026-07-26T00:00:00.000Z',
      cluster: 'devnet',
      transactionStatus: 'broadcast',
      blockhash: 'old-blockhash',
      lastValidBlockHeight: '100',
    },
  ])
  const provider = new WalletDataProvider({
    rpcFactory: () => ({
      getBalance: () => ({ send: async () => ({ value: 0n }) }),
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
      getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
      getBlockHeight: () => ({ send: async () => 101n }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(snapshot.emberActivity[0]).toMatchObject({
    onchainStatus: 'expired',
    failureReason: 'The transaction was not confirmed before its blockhash expired.',
  })
})

test('retries a persisted wallet-owned signed transaction while its blockhash is valid', async () => {
  await storage.setItem('local:ember-cover-records', [
    {
      signature: 'sig-retry',
      walletAddress: ADDRESS,
      coverStatus: 'covered',
      recordedAt: '2026-07-26T00:00:00.000Z',
      cluster: 'devnet',
      transactionStatus: 'signed',
      blockhash: 'valid-blockhash',
      lastValidBlockHeight: '100',
      broadcastOwner: 'wallet',
      signedTransactionBase64: 'signed-transaction',
    },
  ])
  let broadcasts = 0
  const provider = new WalletDataProvider({
    rpcFactory: () => ({
      getBalance: () => ({ send: async () => ({ value: 0n }) }),
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
      getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
      getBlockHeight: () => ({ send: async () => 99n }),
      sendTransaction: () => ({
        send: async () => {
          broadcasts += 1
          return 'sig-retry'
        },
      }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(broadcasts).toBe(1)
  expect(snapshot.emberActivity[0]).toMatchObject({
    onchainStatus: 'broadcast',
    failureReason: null,
  })
})

test('never broadcasts a transaction that a dapp owns', async () => {
  await storage.setItem('local:ember-cover-records', [
    {
      signature: 'sig-dapp',
      walletAddress: ADDRESS,
      coverStatus: 'covered',
      recordedAt: '2026-07-26T00:00:00.000Z',
      cluster: 'devnet',
      transactionStatus: 'signed',
      broadcastOwner: 'dapp',
      signedTransactionBase64: 'must-not-send',
    },
  ])
  let broadcasts = 0
  const provider = new WalletDataProvider({
    rpcFactory: () => ({
      getBalance: () => ({ send: async () => ({ value: 0n }) }),
      getSignaturesForAddress: () => ({ send: async () => [] }),
      getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
      getSignatureStatuses: () => ({ send: async () => ({ value: [null] }) }),
      sendTransaction: () => ({
        send: async () => {
          broadcasts += 1
          return 'sig-dapp'
        },
      }),
    }),
  })

  await provider.getSnapshot(ADDRESS, 1)

  expect(broadcasts).toBe(0)
})

test('does not block SOL balance when token account lookup stalls', async () => {
  const provider = new WalletDataProvider({
    enrichmentTimeoutMs: 1,
    rpcFactory: () => ({
      getBalance: () => ({
        send: async () => ({ value: 5_000_000_000n }),
      }),
      getSignaturesForAddress: () => ({
        send: async () => [],
      }),
      getTokenAccountsByOwner: () => ({
        send: async () => await new Promise<never>(() => {}),
      }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(snapshot.solBalance).toBe('5')
  expect(snapshot.tokenBalances).toEqual([])
  expect(snapshot.tokenBalancesUnavailable).toBe(true)
  expect(snapshot.activityUnavailable).toBe(false)
})

test('does not block SOL balance when transaction history lookup stalls', async () => {
  const provider = new WalletDataProvider({
    enrichmentTimeoutMs: 1,
    rpcFactory: () => ({
      getBalance: () => ({
        send: async () => ({ value: 5_000_000_000n }),
      }),
      getSignaturesForAddress: () => ({
        send: async () => await new Promise<never>(() => {}),
      }),
      getTokenAccountsByOwner: () => ({
        send: async () => ({ value: [] }),
      }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 1)

  expect(snapshot.solBalance).toBe('5')
  expect(snapshot.activity).toEqual([])
  expect(snapshot.activityUnavailable).toBe(true)
  expect(snapshot.tokenBalancesUnavailable).toBe(false)
})

test('classifies recent system transfers when transaction details are available', async () => {
  const provider = new WalletDataProvider({
    rpcFactory: () => ({
      getBalance: () => ({
        send: async () => ({ value: 5_000_000_000n }),
      }),
      getSignaturesForAddress: () => ({
        send: async () => [
          {
            blockTime: 1_772_000_000n,
            confirmationStatus: 'confirmed',
            err: null,
            memo: null,
            signature: 'sig-send',
            slot: 470_000_000n,
          },
          {
            blockTime: 1_772_000_100n,
            confirmationStatus: 'confirmed',
            err: null,
            memo: null,
            signature: 'sig-receive',
            slot: 470_000_001n,
          },
        ],
      }),
      getTransaction: (signature: string) => ({
        send: async () => ({
          transaction: {
            message: {
              instructions: [
                {
                  program: 'system',
                  parsed: {
                    type: 'transfer',
                    info:
                      signature === 'sig-send'
                        ? { source: ADDRESS, destination: 'Recipient111111111111111111111111111111111', lamports: 250_000_000 }
                        : { source: 'Sender111111111111111111111111111111111111', destination: ADDRESS, lamports: 500_000_000 },
                  },
                },
              ],
            },
          },
        }),
      }),
      getTokenAccountsByOwner: () => ({
        send: async () => ({ value: [] }),
      }),
    }),
  })

  const snapshot = await provider.getSnapshot(ADDRESS, 2)

  expect(snapshot.activity[0]).toMatchObject({
    signature: 'sig-send',
    direction: 'sent',
    title: 'Sent 0.25 SOL',
    amount: '0.25 SOL',
    counterparty: 'Recipient111111111111111111111111111111111',
  })
  expect(snapshot.activity[1]).toMatchObject({
    signature: 'sig-receive',
    direction: 'received',
    title: 'Received 0.5 SOL',
    amount: '0.5 SOL',
    counterparty: 'Sender111111111111111111111111111111111111',
  })
})
