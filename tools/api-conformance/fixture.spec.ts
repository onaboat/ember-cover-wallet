import { afterEach, expect, test, vi } from 'vitest'

import { createConformanceWalletFixture } from './fixture.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('rejects every environment except the SDK sandbox', async () => {
  await expect(
    createConformanceWalletFixture({
      baseUrl: 'https://api.ember.example',
      environment: 'production',
    }),
  ).rejects.toThrow('restricted to the sandbox environment')
})

test('rejects a non-loopback plaintext RPC before network access', async () => {
  vi.stubEnv('EMBER_CONFORMANCE_RPC_URL', 'http://rpc.example.com')
  vi.stubEnv(
    'EMBER_CONFORMANCE_RECIPIENT',
    'So11111111111111111111111111111111111111112',
  )
  vi.stubEnv('EMBER_CONFORMANCE_TRANSFER_LAMPORTS', '5000')

  await expect(
    createConformanceWalletFixture({
      baseUrl: 'https://api.ember.example',
      environment: 'sandbox',
    }),
  ).rejects.toThrow('must use HTTPS or exact loopback HTTP')
})

test('rejects a controlled transfer above the hard safety cap before network access', async () => {
  vi.stubEnv('EMBER_CONFORMANCE_RPC_URL', 'https://api.devnet.solana.com')
  vi.stubEnv(
    'EMBER_CONFORMANCE_RECIPIENT',
    'So11111111111111111111111111111111111111112',
  )
  vi.stubEnv('EMBER_CONFORMANCE_TRANSFER_LAMPORTS', '100001')

  await expect(
    createConformanceWalletFixture({
      baseUrl: 'https://api.ember.example',
      environment: 'sandbox',
    }),
  ).rejects.toThrow('must not exceed 100000')
})
