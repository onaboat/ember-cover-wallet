import { estimateWalletImpact } from './transaction-summary.ts'
import type { TxImpactRow, TxPrimaryAction, TxSummary } from './transaction-summary.ts'
import { observedSolChange, simulatedWalletImpact } from './simulation-effects.ts'
import type { SimulationEffects } from './simulation-effects.ts'

export interface ApprovalRecipient {
  address: string
  lamports: bigint
  purpose: 'transfer' | 'account_creation'
}

export interface ApprovalPresentation {
  title: string
  subtitle: string
  recipients: ApprovalRecipient[]
  headline: TxImpactRow
  note: string
  breakdown: TxImpactRow[]
  actions: TxPrimaryAction[]
  warning: string | null
  source: 'decoded' | 'simulated'
}

export function formatSol(lamports: bigint, signed = false): string {
  const absolute = lamports < 0n ? -lamports : lamports
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')
  const prefix = lamports < 0n ? '-' : signed && lamports > 0n ? '+' : ''
  return `${prefix}${absolute / 1_000_000_000n}${fraction ? `.${fraction}` : ''} SOL`
}

function movement(label: string, lamports: bigint): TxImpactRow {
  return { label, value: formatSol(lamports, true), tone: lamports < 0n ? 'negative' : lamports > 0n ? 'positive' : 'neutral' }
}

/** Presentation facts only. Coverage and consent rules remain independent. */
export function approvalPresentation(summary: TxSummary | null, wallet: string | null, effects?: SimulationEffects | null): ApprovalPresentation {
  const impact = estimateWalletImpact(summary, wallet)
  const actions = summary?.instructions.flatMap(ix => ix.effect.status === 'understood' ? [ix.effect.action] : []) ?? []
  const recipients: ApprovalRecipient[] = []
  let outgoing = 0n
  let incoming = 0n
  let funding = 0n
  for (const action of actions) {
    if (action.kind !== 'sol_transfer' && action.kind !== 'account_creation') continue
    if (action.source === wallet && action.recipient !== wallet) {
      if (action.kind === 'account_creation') funding += action.lamports
      else outgoing += action.lamports
      const purpose = action.kind === 'sol_transfer' ? 'transfer' : 'account_creation'
      const existing = recipients.find(r => r.address === action.recipient && r.purpose === purpose)
      if (existing) existing.lamports += action.lamports
      else recipients.push({ address: action.recipient, lamports: action.lamports, purpose: action.kind === 'sol_transfer' ? 'transfer' : 'account_creation' })
    } else if (action.recipient === wallet && action.source !== wallet) incoming += action.lamports
  }
  const ownFee = summary?.feePayer === wallet
  const fee = ownFee ? summary?.baseNetworkFeeLamports ?? null : 0n
  const net = observedSolChange(effects)
  const simulated = simulatedWalletImpact(effects)
  const breakdown: TxImpactRow[] = []
  let headline: TxImpactRow
  let note: string
  if (net !== null) {
    headline = movement('Net SOL change · simulated', net)
    note = ownFee ? 'Includes the network fee. This is a net change, not a spending limit.'
      : summary ? 'The network fee is paid by another account. This is a net change, not a spending limit.'
      : 'This is an observed net change, not a spending limit. The fee payer could not be identified.'
    // There is no authoritative fee breakdown in this response. Do not subtract
    // a base-fee guess and relabel the remainder as a transfer.
    if (ownFee && fee !== null) breakdown.push({ label: 'Base fee estimate · already included', value: formatSol(fee), tone: 'neutral' })
  } else {
    if (outgoing > 0n) breakdown.push(movement('SOL sent', -outgoing))
    if (funding > 0n) breakdown.push(movement('New account funding', -funding))
    if (incoming > 0n) breakdown.push(movement('SOL received', incoming))
    if (ownFee) breakdown.push(fee === null ? { label: 'Network fee', value: 'Not available', tone: 'unknown' } : movement('Base network fee · estimated', -fee))
    else if (summary && wallet) breakdown.push({ label: 'Network fee', value: 'Paid by another account', tone: 'neutral' })
    const complete = impact.isComplete && fee !== null
    const total = incoming - outgoing - funding - (fee ?? 0n)
    if (!summary || !wallet || (!complete && outgoing + funding + incoming === 0n)) {
      headline = { label: 'Total SOL change', value: 'Not available', tone: 'unknown' }
    } else {
      headline = movement(incoming > 0n ? (complete ? 'Net SOL change · estimated' : 'Known net SOL change') : complete ? 'Total SOL leaving · estimated' : 'Known SOL leaving', total)
    }
    note = complete ? (ownFee ? 'Includes the estimated base network fee.' : 'The network fee is paid by another account.') : 'Some effects or fees are unknown. Shown amounts may not be the full cost.'
  }
  if (simulated) breakdown.push(...simulated.rows.filter(row => !row.label.startsWith('Net SOL change')))
  const material = summary?.instructions.filter(ix => ix.effect.status !== 'configuration') ?? []
  const onlySolTransfers = material.length > 0 && material.every(ix => ix.effect.status === 'understood' && ix.effect.action.kind === 'sol_transfer')
  const distinctRecipients = new Set(recipients.map(r => r.address)).size
  const title = onlySolTransfers && outgoing > 0n && incoming === 0n ? 'Send SOL' : summary?.primaryAction.label ?? 'Review transaction'
  const subtitle = recipients.length > 0
    ? (onlySolTransfers ? `Send to ${distinctRecipients === 1 ? 'one recipient' : `${distinctRecipients} recipients`}` : `Known SOL destinations · ${distinctRecipients} ${distinctRecipients === 1 ? 'account' : 'accounts'}`)
    : onlySolTransfers && incoming > 0n ? 'Receive SOL into this wallet' : 'Review the actions requested by this app'
  return { title, subtitle, recipients, headline, note, breakdown,
    actions: actions.filter(a => a.kind !== 'sol_transfer' && a.kind !== 'account_creation'),
    warning: impact.warning, source: net !== null ? 'simulated' : 'decoded' }
}
