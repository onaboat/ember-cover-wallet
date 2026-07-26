import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: ({ mode }) => ({
    name: 'Ember',
    permissions: ['storage'],
    host_permissions: [
      ...(mode === 'development' || process.env.WXT_COVER_PROXY_URL?.startsWith('http://127.0.0.1')
        ? ['http://127.0.0.1:8787/*', 'http://127.0.0.1:18787/*']
        : []),
      'https://*.workers.dev/*',
      'https://solana-devnet.g.alchemy.com/*',
      'https://solana-mainnet.g.alchemy.com/*',
      'https://api.devnet.solana.com/*',
      'https://api.mainnet-beta.solana.com/*',
    ],
  }),
})
