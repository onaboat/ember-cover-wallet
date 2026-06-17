import { expect, test } from 'vitest'

import { decodeTransportBytes } from './transport-bytes.ts'

test('reconstructs bytes from a serialized record', () => {
  expect(Array.from(decodeTransportBytes({ 0: 1, 1: 2, 2: 255 }))).toEqual([1, 2, 255])
})

test('passes through an already-typed array', () => {
  expect(Array.from(decodeTransportBytes(Uint8Array.from([1, 2, 255])))).toEqual([1, 2, 255])
})
