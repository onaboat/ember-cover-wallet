import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test } from 'vitest'

import { DappConnectionStore } from './dapp-connections.ts'

const ORIGIN = 'https://example.test'
const ADDRESS = 'So11111111111111111111111111111111111111112'
const OTHER_ADDRESS = '11111111111111111111111111111111'

beforeEach(() => {
  fakeBrowser.reset()
})

test('stores and returns an authorized dapp connection for the current address', async () => {
  const store = new DappConnectionStore({ now: () => new Date('2026-06-17T00:00:00.000Z') })

  await store.authorize(ORIGIN, ADDRESS)

  expect(await store.get(ORIGIN, ADDRESS)).toMatchObject({
    origin: ORIGIN,
    address: ADDRESS,
    connectedAt: '2026-06-17T00:00:00.000Z',
  })
})

test('disconnect removes only the matching origin', async () => {
  const store = new DappConnectionStore()
  await store.authorize(ORIGIN, ADDRESS)
  await store.authorize('https://other.test', ADDRESS)

  await store.disconnect(ORIGIN)

  expect(await store.get(ORIGIN, ADDRESS)).toBeNull()
  expect(await store.get('https://other.test', ADDRESS)).toMatchObject({ origin: 'https://other.test' })
})

test('stale address authorizations are removed instead of returned', async () => {
  const store = new DappConnectionStore()
  await store.authorize(ORIGIN, ADDRESS)

  expect(await store.get(ORIGIN, OTHER_ADDRESS)).toBeNull()
  expect(await store.list()).toEqual([])
})
