import { defineConfig } from 'wxt'

import { EMBER_CHROME_EXTENSION_PUBLIC_KEY } from './src/config/chrome-identity.ts'

const INSTALLED_DEVNET_QA_PROFILE = 'installed-devnet-qa'
const CANDIDATE_DEVNET_QA_PROFILE = 'candidate-devnet-qa'
const DEVNET_QA_BUILD_ENV = {
  WXT_EMBER_API_BASE_URL: 'https://ember-devnet-qa.up.railway.app',
  WXT_EMBER_ENVIRONMENT: 'sandbox',
  WXT_EMBER_INTEGRATION_ID: 'integration_reference-wallet',
  WXT_EMBER_INTEGRATION_VERSION: '1',
  WXT_SOLANA_RPC_URL: 'https://api.devnet.solana.com',
} as const

const installedDevnetQaBuild =
  process.env.EMBER_BUILD_PROFILE === INSTALLED_DEVNET_QA_PROFILE

const candidateDevnetQaBuild = process.env.EMBER_BUILD_PROFILE === CANDIDATE_DEVNET_QA_PROFILE

if (installedDevnetQaBuild || candidateDevnetQaBuild) {
  for (const [name, expected] of Object.entries(DEVNET_QA_BUILD_ENV)) {
    if (process.env[name] !== expected) {
      throw new Error(
        `${INSTALLED_DEVNET_QA_PROFILE} requires ${name}=${expected}`,
      )
    }
  }
}

function hostPermission(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return `${url.origin}/*`
  } catch {
    return null
  }
}

export default defineConfig({
  srcDir: 'src',
  // Chrome is loaded from .output/chrome-mv3 for live Devnet QA. Keep every
  // other build in an isolated directory so CI, E2E, and local fixture builds
  // cannot silently replace the installed extension with non-live config.
  outDir: installedDevnetQaBuild ? '.output' : candidateDevnetQaBuild ? '.output/qa-candidate' : '.output/nonlive',
  imports: false,
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  dev: {
    server: {
      host: '127.0.0.1',
    },
  },
  manifest: () => {
    const production = process.env.WXT_EMBER_ENVIRONMENT === 'production'
    const rpcUrl =
      process.env.WXT_SOLANA_RPC_URL ??
      (production
        ? 'https://api.mainnet-beta.solana.com'
        : 'https://api.devnet.solana.com')
    const hostPermissions = [
      hostPermission(process.env.WXT_EMBER_API_BASE_URL),
      hostPermission(rpcUrl),
    ].filter((permission): permission is string => permission !== null)
    return {
      description: 'A self-custody Solana wallet with optional Ember Cover integration.',
      key: EMBER_CHROME_EXTENSION_PUBLIC_KEY,
      name: 'Ember',
      permissions: ['storage', 'alarms'],
      host_permissions: [...new Set(hostPermissions)],
    }
  },
})
