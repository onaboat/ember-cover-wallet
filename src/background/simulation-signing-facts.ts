import { isAddress } from '@solana/kit'
import type { SigningDisposition } from '../signing/signing-policy.ts'

const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'])
const HANDOVER_TYPES = new Set(['mintTokens', 'freezeAccount', 'accountOwner', 'closeAccount', 'permanentDelegate'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Decode positive safety facts from Agave's parsed CPI trace. Absence is not a safety guarantee. */
export function simulationSigningBlock(trace: unknown): Extract<SigningDisposition, { status: 'block' }> | null {
  if (!Array.isArray(trace)) return null
  for (const group of trace) {
    if (!record(group) || !Array.isArray(group.instructions)) continue
    for (const instruction of group.instructions) {
      if (!record(instruction) || typeof instruction.programId !== 'string' || !TOKEN_PROGRAMS.has(instruction.programId)) continue
      const parsed = instruction.parsed
      if (!record(parsed) || !record(parsed.info)) continue
      const info = parsed.info
      if (parsed.type === 'approve' || parsed.type === 'approveChecked') {
        const amount = parsed.type === 'approve' ? info.amount : record(info.tokenAmount) ? info.tokenAmount.amount : undefined
        if (amount === '18446744073709551615') return { status: 'block', reason: 'unlimited_token_access' }
      }
      if (parsed.type === 'setAuthority' && typeof info.authorityType === 'string' && HANDOVER_TYPES.has(info.authorityType)) {
        const current = info.authority ?? info.multisigAuthority
        const next = info.newAuthority
        if (typeof current === 'string' && typeof next === 'string' && isAddress(current) && isAddress(next) && current !== next) {
          return { status: 'block', reason: 'authority_handover' }
        }
      }
    }
  }
  return null
}
