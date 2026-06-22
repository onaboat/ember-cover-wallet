import { expect, test } from 'vitest'

import { createQrMatrix } from './qr-code.tsx'

test('creates a fixed version QR matrix for wallet addresses', () => {
  const matrix = createQrMatrix('So11111111111111111111111111111111111111112')

  expect(matrix).toHaveLength(33)
  expect(matrix.every((row) => row.length === 33)).toBe(true)
  expect(matrix.flat().some(Boolean)).toBe(true)
})

test('different addresses produce different QR matrices', () => {
  const first = createQrMatrix('So11111111111111111111111111111111111111112')
  const second = createQrMatrix('11111111111111111111111111111111')

  expect(JSON.stringify(first)).not.toBe(JSON.stringify(second))
})
