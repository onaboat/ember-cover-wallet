import { expect, test } from 'vitest'

import { MAINNET_GENESIS_HASH, emberRuntimeConfig } from './ember-config.ts'

test('production configuration binds HTTPS, mainnet, and the canonical genesis hash', () => {
  const config = emberRuntimeConfig({
    WXT_EMBER_API_BASE_URL: 'https://api.embercover.example/',
    WXT_EMBER_ENVIRONMENT: 'production',
    WXT_EMBER_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
    WXT_EMBER_INTEGRATION_ID: 'integration_reference-wallet',
  })
  expect(config).toMatchObject({
    apiBaseUrl: 'https://api.embercover.example',
    environment: 'production',
    expectedCluster: 'mainnet-beta',
    expectedGenesisHash: MAINNET_GENESIS_HASH,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    integrationId: 'integration_reference-wallet',
    problems: [],
  })
})

test('production rejects insecure transport and sandbox accepts exact loopback HTTP', () => {
  expect(
    emberRuntimeConfig({
      WXT_EMBER_API_BASE_URL: 'http://api.example.com',
      WXT_EMBER_ENVIRONMENT: 'production',
      WXT_EMBER_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
      WXT_EMBER_INTEGRATION_ID: 'integration_reference-wallet',
    }).problems,
  ).toContain('Production Ember API configuration requires HTTPS')
  expect(
    emberRuntimeConfig({
      WXT_EMBER_API_BASE_URL: 'http://127.0.0.1:18787',
      WXT_EMBER_ENVIRONMENT: 'sandbox',
      WXT_EMBER_INTEGRATION_ID: 'integration_reference-wallet',
    }).problems,
  ).toEqual([])
})

test('missing public configuration is explicit instead of silently selecting a demo backend', () => {
  const config = emberRuntimeConfig({})
  expect(config.problems).toEqual([
    'WXT_EMBER_API_BASE_URL is not configured',
    'WXT_EMBER_INTEGRATION_ID must be a canonical integration identifier',
  ])
})
