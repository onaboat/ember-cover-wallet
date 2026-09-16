import type { IntegrationEnvironment } from '@embercover/wallet-sdk'

import type { WalletCluster } from '../background/wallet-data-config.ts'
import { EMBER_CHROME_EXTENSION_ID } from '../config/chrome-identity.ts'

declare global {
  interface ImportMeta {
    readonly env?: Record<string, string | boolean | undefined>
  }
}

export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const DEVNET_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

export interface EmberRuntimeConfig {
  apiBaseUrl: string | null
  environment: IntegrationEnvironment
  expectedCluster: WalletCluster
  expectedGenesisHash: string | null
  extensionId: string | null
  integrationId: string | null
  integrationVersion: number | null
  problems: string[]
}

type EmberConfigEnvironment = Readonly<{
  WXT_EMBER_API_BASE_URL?: string | boolean | undefined
  WXT_EMBER_ENVIRONMENT?: string | boolean | undefined
  WXT_EMBER_INTEGRATION_ID?: string | boolean | undefined
  WXT_EMBER_INTEGRATION_VERSION?: string | boolean | undefined
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
  const integrationVersionText = configuredString(env.WXT_EMBER_INTEGRATION_VERSION)
  const integrationVersion =
    integrationVersionText && /^\d+$/.test(integrationVersionText)
      ? Number(integrationVersionText)
      : null
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
  if (
    integrationVersion === null ||
    !Number.isSafeInteger(integrationVersion) ||
    integrationVersion < 1 ||
    integrationVersion > 2_147_483_647
  ) {
    problems.push('WXT_EMBER_INTEGRATION_VERSION must be a positive signed 32-bit integer')
  }
  return {
    apiBaseUrl,
    environment,
    expectedCluster,
    expectedGenesisHash:
      environment === 'production' ? MAINNET_GENESIS_HASH : DEVNET_GENESIS_HASH,
    extensionId: EMBER_CHROME_EXTENSION_ID,
    integrationId,
    integrationVersion,
    problems,
  }
}

export const EMBER_CONFIG = emberRuntimeConfig({
  WXT_EMBER_API_BASE_URL: import.meta.env?.WXT_EMBER_API_BASE_URL,
  WXT_EMBER_ENVIRONMENT: import.meta.env?.WXT_EMBER_ENVIRONMENT,
  WXT_EMBER_INTEGRATION_ID: import.meta.env?.WXT_EMBER_INTEGRATION_ID,
  WXT_EMBER_INTEGRATION_VERSION: import.meta.env?.WXT_EMBER_INTEGRATION_VERSION,
})
