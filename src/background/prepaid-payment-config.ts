import { address as toAddress } from '@solana/kit'
import type { Address } from '@solana/kit'

import type { WalletCluster } from './wallet-data-config.ts'

declare global {
  interface ImportMeta {
    readonly env?: Record<string, string | boolean | undefined>
  }
}

export interface PrepaidPaymentConfig {
  cluster: Extract<WalletCluster, 'devnet'>
  amountBaseUnits: bigint
  amountUsdc: string
  decimals: number
  periodDays: number
  tier: 'Core'
  tokenMint: Address
  tokenProgram: Address
  treasuryTokenAccount: Address
}

const env = import.meta.env ?? {}
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const DEVNET_TREASURY_TOKEN_ACCOUNT = 'AmXrozEs535RMiwSxkjhcyuq5reC9ntvtBXCef8wCP6s'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const USDC_DECIMALS = 6

function envString(key: string): string | undefined {
  const value = env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(key: string, fallback: string): bigint {
  const value = envString(key) ?? fallback
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${key} must be a positive integer`)
  }
  return BigInt(value)
}

export function formatUsdcBaseUnits(amount: bigint): string {
  const whole = amount / 1_000_000n
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

export function prepaidPaymentConfig(): PrepaidPaymentConfig {
  const amountBaseUnits = positiveInteger('WXT_EMBER_PAY_AMOUNT', '1000000')
  return {
    cluster: 'devnet',
    amountBaseUnits,
    amountUsdc: formatUsdcBaseUnits(amountBaseUnits),
    decimals: USDC_DECIMALS,
    periodDays: 30,
    tier: 'Core',
    tokenMint: toAddress(envString('WXT_EMBER_PAY_MINT') ?? DEVNET_USDC_MINT),
    tokenProgram: toAddress(envString('WXT_EMBER_PAY_TOKEN_PROGRAM') ?? TOKEN_PROGRAM),
    treasuryTokenAccount: toAddress(
      envString('WXT_EMBER_PAY_TREASURY') ?? DEVNET_TREASURY_TOKEN_ACCOUNT,
    ),
  }
}
