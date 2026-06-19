import { address as toAddress } from '@solana/kit'
import type { Address } from '@solana/kit'
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions'

import type { WalletCluster } from './wallet-data-config.ts'

declare global {
  interface ImportMeta {
    readonly env?: Record<string, string | boolean | undefined>
  }
}

export type EmberCoverPlanId = 'core' | 'plus' | 'max'
export type EmberBillingPeriod = 'monthly' | 'annual'

export interface EmberCoverPlan {
  id: EmberCoverPlanId
  name: string
  coverCapUsd: number
  coveredTxAllowance: number
  monthlyPriceUsdc: string
  annualPriceUsdc: string
}

export interface ResolvedSubscriptionPlan {
  display: EmberCoverPlan
  billingPeriod: EmberBillingPeriod
  amountBaseUnits: bigint
  planId: bigint
  renewalPeriodHours: bigint
}

export interface SubscriptionRuntimeConfig {
  cluster: WalletCluster
  merchant?: Address | undefined
  puller?: Address | undefined
  tokenMint?: Address | undefined
  tokenProgram: Address
  programAddress: Address
  missing: string[]
}

const env = import.meta.env ?? {}
const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

export const EMBER_COVER_PLANS: readonly EmberCoverPlan[] = [
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
] as const

export function usdcToBaseUnits(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0')
}

function envString(key: string): string | undefined {
  const value = env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function envAddress(key: string, missing: string[]): Address | undefined {
  const value = envString(key)
  if (!value) {
    missing.push(key)
    return undefined
  }
  try {
    return toAddress(value)
  } catch {
    missing.push(`${key} valid Solana address`)
    return undefined
  }
}

function envBigInt(key: string, missing: string[]): bigint | undefined {
  const value = envString(key)
  if (!value) {
    missing.push(key)
    return undefined
  }
  if (!/^\d+$/.test(value)) {
    missing.push(`${key} numeric plan id`)
    return undefined
  }
  return BigInt(value)
}

function planEnvKey(planId: EmberCoverPlanId, billingPeriod: EmberBillingPeriod): string {
  return `WXT_EMBER_SUBSCRIPTION_${planId.toUpperCase()}_${billingPeriod.toUpperCase()}_PLAN_ID`
}

export function subscriptionRuntimeConfig(cluster: WalletCluster): SubscriptionRuntimeConfig {
  const missing: string[] = []
  const mintKey =
    cluster === 'mainnet-beta' ? 'WXT_EMBER_SUBSCRIPTION_MAINNET_USDC_MINT' : 'WXT_EMBER_SUBSCRIPTION_DEVNET_USDC_MINT'
  const mintFallback = cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : undefined
  const tokenMintValue = envString(mintKey) ?? mintFallback
  let tokenMint: Address | undefined
  if (tokenMintValue) {
    try {
      tokenMint = toAddress(tokenMintValue)
    } catch {
      missing.push(`${mintKey} valid Solana address`)
    }
  } else {
    missing.push(mintKey)
  }
  return {
    cluster,
    merchant: envAddress('WXT_EMBER_SUBSCRIPTION_MERCHANT', missing),
    puller: envAddress('WXT_EMBER_SUBSCRIPTION_PULLER', missing),
    tokenMint,
    tokenProgram: toAddress(envString('WXT_EMBER_SUBSCRIPTION_TOKEN_PROGRAM') ?? TOKEN_PROGRAM),
    programAddress: toAddress(envString('WXT_EMBER_SUBSCRIPTION_PROGRAM_ID') ?? SUBSCRIPTIONS_PROGRAM_ADDRESS),
    missing,
  }
}

export function resolveSubscriptionPlan(
  planId: EmberCoverPlanId,
  billingPeriod: EmberBillingPeriod,
): ResolvedSubscriptionPlan {
  const display = EMBER_COVER_PLANS.find((plan) => plan.id === planId)
  if (!display) {
    throw new Error('Unknown Ember Cover plan')
  }
  const missing: string[] = []
  const onchainPlanId = envBigInt(planEnvKey(planId, billingPeriod), missing)
  if (onchainPlanId === undefined) {
    throw new Error(`Solana subscription plan config missing: ${missing.join(', ')}`)
  }
  const price = billingPeriod === 'monthly' ? display.monthlyPriceUsdc : display.annualPriceUsdc
  return {
    display,
    billingPeriod,
    amountBaseUnits: usdcToBaseUnits(price),
    planId: onchainPlanId,
    renewalPeriodHours: billingPeriod === 'monthly' ? 720n : 8760n,
  }
}
