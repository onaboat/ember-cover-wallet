import type { WalletCluster } from './wallet-data-config.ts'

export const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

export interface TrustedTokenMetadata {
  cluster: WalletCluster
  mint: string
  programId: string
  name: string
  symbol: string
  iconText: string
}

const TRUSTED_TOKENS: readonly TrustedTokenMetadata[] = [
  {
    cluster: 'devnet',
    mint: DEVNET_USDC_MINT,
    programId: TOKEN_PROGRAM_ADDRESS,
    name: 'USD Coin',
    symbol: 'USDC',
    iconText: '$',
  },
] as const

export function trustedTokenMetadata(
  cluster: WalletCluster,
  mint: string,
  programId: string,
): TrustedTokenMetadata | null {
  return (
    TRUSTED_TOKENS.find(
      (token) => token.cluster === cluster && token.mint === mint && token.programId === programId,
    ) ?? null
  )
}

export function shortTokenMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint
}
