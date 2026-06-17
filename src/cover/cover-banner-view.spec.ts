import { expect, test } from 'vitest'

import { bannerView } from './cover-banner-view.ts'

test('covered + medium risk reads as covered, no ack', () => {
  expect(bannerView({ coverStatus: 'covered', riskBand: 'medium' }, false)).toEqual({
    label: 'Covered by Ember',
    tone: 'covered',
    showAck: false,
  })
})

test('covered + high risk asks for an acknowledgment', () => {
  expect(bannerView({ coverStatus: 'covered', riskBand: 'high' }, false).showAck).toBe(true)
})

test('not_covered reads as not covered', () => {
  expect(bannerView({ coverStatus: 'not_covered', riskBand: 'severe' }, false).tone).toBe('none')
})

test('unsupported is opaque to the user (also "not covered")', () => {
  expect(bannerView({ coverStatus: 'unsupported', riskBand: 'high' }, false).label).toBe('Not covered')
})

test('unavailable reads as cover unavailable', () => {
  expect(bannerView({ coverStatus: 'unavailable', riskBand: 'severe' }, false).tone).toBe('unavailable')
})

test('loading before a decision reads as checking', () => {
  expect(bannerView(null, true).label).toContain('Checking')
})
