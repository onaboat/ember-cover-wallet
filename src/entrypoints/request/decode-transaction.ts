import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'

import { decodeTransportBytes } from '../../messaging/transport-bytes.ts'

const KNOWN_PROGRAMS: Record<string, string> = {
  '11111111111111111111111111111111': 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token Program',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
}

export interface TxInstructionSummary {
  program: string
  programName: string
}

export interface TxSummary {
  feePayer: string
  instructions: TxInstructionSummary[]
}

/**
 * Decode a transaction (raw bytes or the serialized `{0:n,...}` transport record) into a readable
 * summary: the fee payer (first static account) and a list of instructions (program address +
 * friendly name for known programs). Pure and defensive: returns null on any decode failure so a
 * malformed transaction can never crash the approval popup.
 */
export function decodeTransactionSummary(
  transaction: Uint8Array | Record<string, number>,
): TxSummary | null {
  try {
    const tx = getTransactionDecoder().decode(decodeTransportBytes(transaction))
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
    const accounts = message.staticAccounts
    const feePayer = accounts[0]
    if (!feePayer) {
      return null
    }
    const instructions = message.instructions.map((ix) => {
      const program = accounts[ix.programAddressIndex] ?? '(unknown)'
      return { program: String(program), programName: KNOWN_PROGRAMS[String(program)] ?? 'Program' }
    })
    return { feePayer: String(feePayer), instructions }
  } catch {
    return null
  }
}
