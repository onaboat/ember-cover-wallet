import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test } from 'vitest'

import { CoverRecordStore, toWalletCoverStatus } from './cover-records.ts'

const KEY = 'local:ember-cover-records'
const WALLET = 'So11111111111111111111111111111111111111112'
const OTHER = '11111111111111111111111111111112'

beforeEach(() => {
  fakeBrowser.reset()
})

function store() {
  return new CoverRecordStore({ now: () => new Date('2026-06-21T00:00:00.000Z') })
}

test('record persists a cover record keyed by signature', async () => {
  await store().record({ signature: 'sig1', walletAddress: WALLET, coverStatus: 'covered' })
  const stored = await storage.getItem<Array<{ signature: string }>>(KEY)
  expect(stored?.[0]?.signature).toBe('sig1')
})

test('record persists transaction details for useful pending activity', async () => {
  await store().record({
    signature: 'sig1',
    walletAddress: WALLET,
    coverStatus: 'covered',
    title: 'Sent 1 USDC',
    actionKind: 'token_transfer',
    amount: '1 USDC',
    tokenSymbol: 'USDC',
    tokenMint: OTHER,
    recipient: OTHER,
    programs: ['Token Program'],
    cluster: 'devnet',
    transactionStatus: 'broadcast',
    blockhash: 'blockhash',
    lastValidBlockHeight: '123',
    broadcastOwner: 'wallet',
    signedTransactionBase64: 'signed',
  })
  const [record] = await store().list(WALLET, 'devnet')
  expect(record).toMatchObject({
    title: 'Sent 1 USDC',
    amount: '1 USDC',
    tokenSymbol: 'USDC',
    recipient: OTHER,
    programs: ['Token Program'],
    cluster: 'devnet',
    transactionStatus: 'broadcast',
    blockhash: 'blockhash',
    lastValidBlockHeight: '123',
    broadcastOwner: 'wallet',
    signedTransactionBase64: 'signed',
  })
})

test('updates persisted transaction state without losing the original record time', async () => {
  let now = new Date('2026-07-26T00:00:00.000Z')
  const records = new CoverRecordStore({ now: () => now })
  await records.record({
    signature: 'sig',
    walletAddress: WALLET,
    coverStatus: 'covered',
    cluster: 'devnet',
    transactionStatus: 'broadcast',
  })
  now = new Date('2026-07-26T00:01:00.000Z')

  await records.updateTransactionStates([
    {
      signature: 'sig',
      walletAddress: WALLET,
      transactionStatus: 'confirmed',
    },
  ])

  expect(await records.list(WALLET, 'devnet')).toMatchObject([
    {
      recordedAt: '2026-07-26T00:00:00.000Z',
      lastCheckedAt: '2026-07-26T00:01:00.000Z',
      transactionStatus: 'confirmed',
      failureReason: null,
    },
  ])
})

test('legacy records without a cluster are treated as Devnet only', async () => {
  await storage.setItem(KEY, [
    {
      signature: 'legacy',
      walletAddress: WALLET,
      coverStatus: 'covered',
      recordedAt: '2026-07-26T00:00:00.000Z',
    },
  ])
  const records = store()

  expect(await records.list(WALLET, 'devnet')).toHaveLength(1)
  expect(await records.list(WALLET, 'mainnet-beta')).toHaveLength(0)
})

test('record upserts by signature so the latest verdict wins', async () => {
  const records = store()
  await records.record({ signature: 'sig1', walletAddress: WALLET, coverStatus: 'covered' })
  await records.record({ signature: 'sig1', walletAddress: WALLET, coverStatus: 'not_covered' })
  const list = await records.list(WALLET)
  expect(list).toHaveLength(1)
  expect(list[0]?.coverStatus).toBe('not_covered')
})

test('record caps the stored list at 50, dropping the oldest', async () => {
  const records = store()
  for (let i = 0; i < 51; i += 1) {
    await records.record({ signature: `sig${i}`, walletAddress: WALLET, coverStatus: 'covered' })
  }
  const list = await records.list(WALLET)
  expect(list).toHaveLength(50)
  expect(list.some((record) => record.signature === 'sig0')).toBe(false)
})

test('list returns only records for the given wallet', async () => {
  const records = store()
  await records.record({ signature: 'sig1', walletAddress: WALLET, coverStatus: 'covered' })
  await records.record({ signature: 'sig2', walletAddress: OTHER, coverStatus: 'covered' })
  const list = await records.list(WALLET)
  expect(list).toHaveLength(1)
  expect(list[0]?.signature).toBe('sig1')
})

test('toWalletCoverStatus folds unsupported to not_covered and passes others through', () => {
  expect(toWalletCoverStatus('unsupported')).toBe('not_covered')
  expect(toWalletCoverStatus('covered')).toBe('covered')
  expect(toWalletCoverStatus('not_covered')).toBe('not_covered')
  expect(toWalletCoverStatus('unavailable')).toBe('unavailable')
})
