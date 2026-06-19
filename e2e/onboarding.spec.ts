import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type BrowserContext, chromium, expect, test } from '@playwright/test'

const EXT = path.resolve('.output/chrome-mv3')

async function launch(): Promise<{ context: BrowserContext; extensionId: string }> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'ember-cover-wallet-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')
  return { context, extensionId: new URL(sw.url()).host }
}

test('create a vault, lock, and unlock', async () => {
  const { context, extensionId } = await launch()
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/popup.html`)

  await page.getByTestId('password').fill('Str0ng-pass-correct-horse')
  await page.getByTestId('submit').click()
  const address = await page.getByTestId('address').textContent({ timeout: 30000 })
  expect((address ?? '').length).toBeGreaterThan(31)
  await expect(page.getByTestId('wallet-cluster')).toBeVisible()
  await expect(page.getByTestId('main-tabs')).toBeVisible()
  await expect(page.getByTestId('wallet-balance')).toBeVisible()
  await expect(page.getByTestId('wallet-tokens')).toBeVisible()
  await expect(page.getByTestId('wallet-cover-status')).toBeVisible()
  await page.getByTestId('receive').click()
  await expect(page.getByTestId('receive-qr')).toBeVisible()
  await expect(page.getByTestId('receive-address')).toHaveText(address ?? '')
  await page.getByTestId('tab-assets').click()
  await page.getByTestId('tab-activity').click()
  await expect(page.getByTestId('wallet-activity')).toBeVisible()

  await page.getByTestId('lock').click()
  await page.getByTestId('password').fill('Str0ng-pass-correct-horse')
  await page.getByTestId('submit').click()
  await expect(page.getByTestId('address')).toHaveText(address ?? '', { timeout: 30000 })

  await context.close()
})
