import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

// Render the production component and stylesheet with the long token data from
// S07a. This isolates layout from wallet creation, RPC and signing policy.
for (const width of [360, 400]) {
  for (const tone of ['covered', 'none']) {
    test(`token and fee rows remain readable at ${width}px (${tone})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 600 })
      const css = await readFile('src/assets/global.css', 'utf8')
      const { stdout: markup } = await promisify(execFile)('bun', ['e2e/fixtures/render-approval-layout.ts', tone])
      await page.setContent(`<style>${css}</style>${markup}`)
      const amounts = page.getByTestId('estimated-changes')
      await expect(amounts).toContainText('C21EF5tdZJnsb8x7qpMZKg8A3gPLiVgseK1SxpsyxJNb')
      await expect(amounts).toContainText('Fqyw4PnWRYk8QMdYmTLeUJnhMJPQTTZGK7BN3TUYkAzM')
      await expect(amounts).toContainText('+5000000 raw token units')
      const rows = amounts.locator('dl > div')
      for (const row of await rows.all()) {
        const bounds = await row.boundingBox()
        expect(bounds!.height, 'A balance row must not become a column of individual characters').toBeLessThan(100)
        const value = await row.locator('dd').boundingBox()
        expect(value!.x + value!.width).toBeLessThanOrEqual(width - 16)
      }
      const feeLines = await rows.first().locator('dd').evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        return range.getClientRects().length
      })
      expect(feeLines, 'The fee amount and SOL unit fit on one line').toBe(1)
      expect((await amounts.boundingBox())!.height).toBeLessThan(400)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      await page.screenshot({ path: testInfo.outputPath('token-approval.png') })
    })
  }
}
