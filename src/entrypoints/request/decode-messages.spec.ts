import { expect, test } from 'vitest'

import { decodeMessages } from './decode-messages.ts'

test('renders printable UTF-8 as text', () => {
  expect(decodeMessages([{ message: new TextEncoder().encode('hello') }])).toBe('hello')
})

test('renders non-printable bytes as hex, not mojibake', () => {
  expect(decodeMessages([{ message: Uint8Array.from([0, 1, 2]) }])).toBe('0x000102')
})
