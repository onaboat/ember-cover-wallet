import { fakeBrowser } from 'wxt/testing'
import { SOLANA_LOCALNET_CHAIN } from '@solana/wallet-standard-chains'
import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('./request-service.ts', () => ({ requestService: vi.fn() }))

import { requestService } from './request-service.ts'
import { buildConnectAccount } from './build-account.ts'
import { dappConnections } from './dapp-connections.ts'
import { connect, disconnect, signTransaction } from './actions.ts'

const ORIGIN = 'https://x'
const ADDRESS = 'So11111111111111111111111111111111111111112'
const OTHER_ADDRESS = '11111111111111111111111111111111'

beforeEach(() => {
  fakeBrowser.reset()
  vi.clearAllMocks()
})

function mockRequestService() {
  const create = vi.fn(async () => ({ accounts: [buildConnectAccount(ADDRESS)] }))
  const currentAddress = vi.fn(async () => ADDRESS)
  vi.mocked(requestService).mockReturnValue({ create, currentAddress } as never)
  return { create, currentAddress }
}

test('connect routes to requestService.create with type, input, origin', async () => {
  const { create } = mockRequestService()
  await connect(undefined, ORIGIN)
  expect(create).toHaveBeenCalledWith('connect', undefined, ORIGIN)
})

test('approved connect authorizes the dapp origin for silent reconnect', async () => {
  mockRequestService()

  await connect(undefined, ORIGIN)

  expect(await dappConnections.get(ORIGIN, ADDRESS)).toMatchObject({ origin: ORIGIN, address: ADDRESS })
})

test('silent connect returns no account when the origin has not been approved', async () => {
  const { create } = mockRequestService()

  const output = await connect({ silent: true }, ORIGIN)

  expect(output.accounts).toEqual([])
  expect(create).not.toHaveBeenCalled()
})

test('silent connect returns the approved account without opening an approval request', async () => {
  const { create } = mockRequestService()
  await dappConnections.authorize(ORIGIN, ADDRESS)

  const output = await connect({ silent: true }, ORIGIN)

  expect(output.accounts[0]?.address).toBe(ADDRESS)
  expect(create).not.toHaveBeenCalled()
})

test('silent connect drops a stored origin when the wallet address changed', async () => {
  const { create, currentAddress } = mockRequestService()
  await dappConnections.authorize(ORIGIN, OTHER_ADDRESS)

  const output = await connect({ silent: true }, ORIGIN)

  expect(output.accounts).toEqual([])
  expect(await dappConnections.list()).toEqual([])
  expect(currentAddress).toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

test('disconnect removes the dapp origin authorization', async () => {
  mockRequestService()
  await dappConnections.authorize(ORIGIN, ADDRESS)

  await disconnect(ORIGIN)

  expect(await dappConnections.get(ORIGIN, ADDRESS)).toBeNull()
})

test('rejects unsupported transaction chains before opening an approval window', async () => {
  const { create } = mockRequestService()

  await expect(
    signTransaction(
      [
        {
          account: buildConnectAccount(ADDRESS),
          transaction: Uint8Array.from([1]),
          chain: SOLANA_LOCALNET_CHAIN,
        },
      ],
      ORIGIN,
    ),
  ).rejects.toThrow('does not support')

  expect(create).not.toHaveBeenCalled()
})
