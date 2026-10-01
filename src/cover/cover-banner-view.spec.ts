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

test('unsupported distinguishes unknown effects from a coverage refusal', () => {
  expect(bannerView({ coverStatus: 'unsupported', riskBand: 'high' }, false)).toMatchObject({
    label: 'Effects not understood',
    body: 'Ember could not sufficiently understand this approval. Cover does not apply.',
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
    body: 'Ember is evaluating this exact approval. Nothing has been signed.',
    approveLabel: 'Checking cover...',
  })
})

// A drain must be unmistakable at a glance: the headline names the danger, not only the
// missing cover, so a skimming owner cannot miss that the transaction empties their wallet.
const walletDrain = {
  coverStatus: 'not_covered',
  riskBand: 'severe',
  signingDisposition: { status: 'acknowledge', reason: 'wallet_drain' },
} as const

test('a wallet drain is headlined as a wallet drain', () => {
  expect(bannerView(walletDrain, false).label).toBe('Looks like a wallet drain')
})

test('a wallet drain says what will happen to the funds', () => {
  expect(bannerView(walletDrain, false).body).toMatch(/whole token balance|nearly all your SOL/)
})

test('a wallet drain is shown in the danger tone', () => {
  expect(bannerView(walletDrain, false).tone).toBe('blocked')
})

test('a wallet drain asks the owner to accept losing the funds before signing', () => {
  expect(bannerView(walletDrain, false).ackLabel).toMatch(/empty my wallet/)
})
