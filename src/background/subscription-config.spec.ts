import { expect, test } from 'vitest'

import { EMBER_COVER_PLANS, usdcToBaseUnits } from './subscription-config.ts'

test('defines the Ember Cover plan display terms', () => {
  expect(EMBER_COVER_PLANS).toEqual([
    {
      id: 'core',
      name: 'Core',
      coverCapUsd: 10_000,
      coveredTxAllowance: 100,
      monthlyPriceUsdc: '19.99',
      annualPriceUsdc: '199',
    },
    {
      id: 'plus',
      name: 'Plus',
      coverCapUsd: 25_000,
      coveredTxAllowance: 150,
      monthlyPriceUsdc: '29.99',
      annualPriceUsdc: '299',
    },
    {
      id: 'max',
      name: 'Max',
      coverCapUsd: 50_000,
      coveredTxAllowance: 250,
      monthlyPriceUsdc: '49.99',
      annualPriceUsdc: '499',
    },
  ])
})

test('converts USDC display amounts to six-decimal base units', () => {
  expect(usdcToBaseUnits('19.99')).toBe(19_990_000n)
  expect(usdcToBaseUnits('199')).toBe(199_000_000n)
})
