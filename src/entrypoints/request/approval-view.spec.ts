import { expect, test } from 'vitest'

import { bannerView } from '../../cover/cover-banner-view.ts'
import { coverDisplay } from './ApprovalScreen.tsx'

test('a missing Ember session asks to reconnect before checking existing cover', () => {
  const cover = {
    coverStatus: 'not_covered' as const,
    riskBand: 'low' as const,
    debug: { stage: 'not_enrolled' as const, apiAttempted: false },
  }
  expect(coverDisplay(cover, bannerView(cover, false), false, false)).toMatchObject({
    label: 'Ember connection needed',
    nextAction: 'reconnect',
  })
})

test('a server-confirmed absence of active cover opens setup', () => {
  const cover = {
    coverStatus: 'not_covered' as const,
    riskBand: 'low' as const,
    debug: { stage: 'not_enrolled' as const, apiAttempted: true },
  }
  expect(coverDisplay(cover, bannerView(cover, false), false, false)).toMatchObject({
    label: 'No active cover found',
    nextAction: 'setup',
  })
})

test('covered approval with incomplete displayed effects remains a visible warning', () => {
  const cover = { coverStatus: 'covered' as const, riskBand: 'medium' as const }
  expect(coverDisplay(cover, bannerView(cover, false), false, true)).toMatchObject({
    label: 'Cover available; effects unclear',
    tone: 'warning',
  })
})
