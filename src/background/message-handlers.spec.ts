import { expect, test } from 'vitest'

import { originOf } from './message-handlers.ts'

test('derives the origin from sender.url', () => {
  expect(originOf({ url: 'https://app.x.io/path?q=1' } as never)).toBe('https://app.x.io')
})

test('returns undefined when there is no url', () => {
  expect(originOf({} as never)).toBeUndefined()
})
