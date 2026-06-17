import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: {
    name: 'Ember',
    permissions: ['storage'],
    host_permissions: ['https://ember-v4-api-devnet.fly.dev/*'],
  },
})
