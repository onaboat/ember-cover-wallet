import { defineConfig } from 'wxt'

import { EMBER_CHROME_EXTENSION_PUBLIC_KEY } from './src/config/chrome-identity.ts'

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
