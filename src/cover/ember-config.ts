import type { IntegrationEnvironment } from '@embercover/wallet-sdk'

import type { WalletCluster } from '../background/wallet-data-config.ts'

declare global {
  interface ImportMeta {
    readonly env?: Record<string, string | boolean | undefined>
  }
}

export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

export interface EmberRuntimeConfig {
  apiBaseUrl: string | null
  environment: IntegrationEnvironment
  expectedCluster: WalletCluster
  expectedGenesisHash: string | null
  extensionId: string | null
  integrationId: string | null
  problems: string[]
}

type EmberConfigEnvironment = Readonly<{
  WXT_EMBER_API_BASE_URL?: string | boolean | undefined
  WXT_EMBER_ENVIRONMENT?: string | boolean | undefined
  WXT_EMBER_EXTENSION_ID?: string | boolean | undefined
  WXT_EMBER_INTEGRATION_ID?: string | boolean | undefined
}>

function configuredString(
  value: string | boolean | undefined,
): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function emberRuntimeConfig(
  env: EmberConfigEnvironment = {},
): EmberRuntimeConfig {
  const environment: IntegrationEnvironment =
    env.WXT_EMBER_ENVIRONMENT === 'production' ? 'production' : 'sandbox'
  const expectedCluster: WalletCluster =
    environment === 'production' ? 'mainnet-beta' : 'devnet'
  const apiBaseUrl = configuredString(env.WXT_EMBER_API_BASE_URL)?.replace(/\/$/, '') ?? null
  const integrationId = configuredString(env.WXT_EMBER_INTEGRATION_ID)
  const extensionId = configuredString(env.WXT_EMBER_EXTENSION_ID)
  const problems: string[] = []

  if (!apiBaseUrl) {
    problems.push('WXT_EMBER_API_BASE_URL is not configured')
  } else {
    try {
      const url = new URL(apiBaseUrl)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== '' && url.pathname !== '/')
      ) {
        problems.push('WXT_EMBER_API_BASE_URL must be an origin without credentials or a path')
      }
      if (environment === 'production' && url.protocol !== 'https:') {
        problems.push('Production Ember API configuration requires HTTPS')
      }
      const sandboxLoopback =
        url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
      if (
        environment === 'sandbox' &&
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && sandboxLoopback)
      ) {
        problems.push('Sandbox HTTP is allowed only on an exact loopback host')
      }
    } catch {
      problems.push('WXT_EMBER_API_BASE_URL must be an absolute HTTP(S) origin')
    }
  }

  if (!integrationId || !/^integration_[a-z0-9-]+$/.test(integrationId)) {
    problems.push('WXT_EMBER_INTEGRATION_ID must be a canonical integration identifier')
  }
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) {
    problems.push('WXT_EMBER_EXTENSION_ID must be an exact 32-character Chrome extension ID')
  }
  if (environment === 'production' && !extensionId) {
    problems.push('Production requires WXT_EMBER_EXTENSION_ID for exact origin binding')
  }

  return {
    apiBaseUrl,
    environment,
    expectedCluster,
    expectedGenesisHash: environment === 'production' ? MAINNET_GENESIS_HASH : null,
    extensionId,
    integrationId,
    problems,
  }
}

export const EMBER_CONFIG = emberRuntimeConfig({
  WXT_EMBER_API_BASE_URL: import.meta.env?.WXT_EMBER_API_BASE_URL,
  WXT_EMBER_ENVIRONMENT: import.meta.env?.WXT_EMBER_ENVIRONMENT,
  WXT_EMBER_EXTENSION_ID: import.meta.env?.WXT_EMBER_EXTENSION_ID,
  WXT_EMBER_INTEGRATION_ID: import.meta.env?.WXT_EMBER_INTEGRATION_ID,
})
