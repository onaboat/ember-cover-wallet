import { createHash } from 'node:crypto'

import { expect, test } from 'vitest'

import {
  EMBER_CHROME_EXTENSION_ID,
  EMBER_CHROME_EXTENSION_PUBLIC_KEY,
} from './chrome-identity.ts'

test('the public Web Store key derives the committed Chrome extension ID', () => {
  const publicKey = Buffer.from(EMBER_CHROME_EXTENSION_PUBLIC_KEY, 'base64')
  expect(publicKey.toString('base64')).toBe(EMBER_CHROME_EXTENSION_PUBLIC_KEY)

  const id = [...createHash('sha256').update(publicKey).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('')

  expect(id).toBe(EMBER_CHROME_EXTENSION_ID)
})
