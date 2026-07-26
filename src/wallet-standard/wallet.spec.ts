import { SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features'
import { StandardConnect, StandardDisconnect, StandardEvents } from '@wallet-standard/core'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { buildConnectAccount } from '../background/build-account.ts'
import { sendMessage } from '../messaging/window.ts'
import { EmberWallet } from './wallet.ts'

vi.mock('../messaging/window.ts', () => ({ sendMessage: vi.fn() }))

const ADDRESS = 'So11111111111111111111111111111111111111112'

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(sendMessage).mockResolvedValue({ accounts: [] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

test('advertises exactly the five implemented features', () => {
  expect(Object.keys(new EmberWallet().features).sort()).toEqual(
    [SolanaSignMessage, SolanaSignTransaction, StandardConnect, StandardDisconnect, StandardEvents].sort(),
  )
})

test('advertises Devnet and Mainnet but not unsupported local/test clusters', () => {
  expect(new EmberWallet().chains).toEqual(['solana:devnet', 'solana:mainnet'])
})

test('silently restores an approved account after provider injection', async () => {
  vi.mocked(sendMessage).mockResolvedValueOnce({
    accounts: [buildConnectAccount(ADDRESS)],
  } as never)
  const wallet = new EmberWallet()
  const changes: string[] = []
  wallet.features[StandardEvents].on('change', ({ accounts }) => {
    const address = accounts?.[0]?.address
    if (address) {
      changes.push(address)
    }
  })

  await vi.advanceTimersByTimeAsync(0)

  expect(sendMessage).toHaveBeenCalledWith('connect', { silent: true })
  expect(wallet.accounts[0]?.address).toBe(ADDRESS)
  expect(changes).toEqual([ADDRESS])
})
