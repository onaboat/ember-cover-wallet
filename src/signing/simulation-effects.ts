import type { TxImpactRow, TxWalletImpact } from './transaction-summary.ts'

export interface SimulationEffects {
  contextSlot: string
  solBalanceBefore?: string | null
  solBalanceAfter?: string | null
  tokenBalances: { account: string; mint: string; preAmount: string; postAmount: string }[]
}

function amount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid balance')
  const result = BigInt(value)
  if (result > 18_446_744_073_709_551_615n) throw new Error('Invalid balance')
  return result
}

function change(before: string, after: string, decimals: number): Pick<TxImpactRow, 'value' | 'tone'> {
  const delta = amount(after) - amount(before)
  const absolute = delta < 0n ? -delta : delta
  const scale = 10n ** BigInt(decimals)
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return {
    value: `${delta < 0n ? '-' : delta > 0n ? '+' : ''}${absolute / scale}${decimals && fraction ? `.${fraction}` : ''}`,
    tone: delta < 0n ? 'negative' : delta > 0n ? 'positive' : 'neutral',
  }
}

/** Observations supplement decoded instructions; they do not establish intent. */
export function simulatedWalletImpact(effects: SimulationEffects | null | undefined): TxWalletImpact | null {
  if (!effects) return null
  try {
    amount(effects.contextSlot)
    const rows: TxImpactRow[] = []
    if (effects.solBalanceBefore != null && effects.solBalanceAfter != null) {
      const sol = change(effects.solBalanceBefore, effects.solBalanceAfter, 9)
      rows.push({ label: 'Net SOL change, including network fee', ...sol, value: `${sol.value} SOL` })
    }
    for (const token of effects.tokenBalances) {
      const delta = change(token.preAmount, token.postAmount, 0)
      rows.push({ label: `Token ${token.mint}`, ...delta, value: `${delta.value} raw token units` })
      rows.push({ label: 'Token account', value: token.account, tone: 'neutral' })
    }
    if (!rows.length) return null
    return { title: 'Simulated balance changes', rows, isComplete: false,
      warning: `Observed at slot ${effects.contextSlot}. These are net balance changes, not a guarantee of all effects or future execution.` }
  } catch {
    return null
  }
}
