import { expect, test } from 'vitest'

import { topRightPopupPosition } from './popup-position.ts'

test('places the popup against the top-right of the browser window (Phantom-style)', () => {
  expect(topRightPopupPosition({ left: 0, top: 0, width: 1440 }, 376, 16)).toEqual({ left: 1048, top: 16 })
})

test('offsets relative to a browser window that is not at the screen origin', () => {
  expect(topRightPopupPosition({ left: 100, top: 50, width: 1200 }, 376, 16)).toEqual({ left: 908, top: 66 })
})

test('never returns a negative left when the window is narrower than the popup', () => {
  expect(topRightPopupPosition({ left: 0, top: 0, width: 300 }, 376, 16).left).toBe(0)
})
