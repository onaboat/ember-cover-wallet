import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing'

export default defineConfig({
  plugins: [WxtVitest()],
  // Argon2id at wallet-grade cost (~2.4s/derive) makes vault tests slow by design.
  test: {
    environment: 'node',
    testTimeout: 30000,
    // e2e/ holds Playwright specs (their own runner) — keep them out of vitest.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.output/**', '**/.wxt/**', 'e2e/**'],
  },
})
