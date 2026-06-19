import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: {
    name: 'Ember',
    permissions: ['storage'],
    host_permissions: [
      'http://127.0.0.1:8787/*',
      'https://ember-v4-api-devnet.fly.dev/*',
      'https://*.workers.dev/*',
      'https://api.devnet.solana.com/*',
      'https://api.mainnet-beta.solana.com/*',
    ],
  },
})
