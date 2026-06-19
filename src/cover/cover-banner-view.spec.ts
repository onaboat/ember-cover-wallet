import { expect, test } from 'vitest'

import { bannerView } from './cover-banner-view.ts'

test('covered + medium risk reads as covered, no ack', () => {
  expect(bannerView({ coverStatus: 'covered', riskBand: 'medium' }, false)).toEqual({
    label: 'Covered',
    body: 'Cover is available for this approval.',
    tone: 'covered',
    showAck: false,
    ackLabel: null,
    approveLabel: 'Approve and sign',
  })
})

test('covered + high risk asks for an acknowledgment', () => {
  expect(bannerView({ coverStatus: 'covered', riskBand: 'high' }, false)).toMatchObject({
    label: 'Covered, high risk',
    body: 'Cover is available, but review carefully.',
    showAck: true,
    ackLabel: 'I understand this is high risk.',
    approveLabel: 'Approve high-risk transaction',
  })
})

test('not_covered reads as not covered and requires no-cover acknowledgment', () => {
  expect(bannerView({ coverStatus: 'not_covered', riskBand: 'severe' }, false)).toMatchObject({
    label: 'Not covered',
    body: 'Ember will not protect this approval.',
    tone: 'none',
    showAck: true,
    ackLabel: 'I understand I am signing without cover.',
    approveLabel: 'Sign without cover',
  })
})

test('unsupported is opaque to the user (also "not covered")', () => {
  expect(bannerView({ coverStatus: 'unsupported', riskBand: 'high' }, false)).toMatchObject({
    label: 'Not covered',
    body: 'This approval is outside Ember Cover.',
    showAck: true,
    approveLabel: 'Sign without cover',
  })
})

test('unavailable reads as cover unavailable', () => {
  expect(bannerView({ coverStatus: 'unavailable', riskBand: 'severe' }, false)).toMatchObject({
    label: 'Cover unavailable',
    body: 'Ember cannot check this approval right now.',
    tone: 'unavailable',
    showAck: true,
    ackLabel: 'I understand cover is unavailable.',
    approveLabel: 'Sign without cover',
  })
})

test('loading before a decision reads as checking', () => {
  expect(bannerView(null, true)).toMatchObject({
    label: 'Checking cover...',
    body: 'Waiting for Ember.',
    approveLabel: 'Checking cover...',
  })
})
