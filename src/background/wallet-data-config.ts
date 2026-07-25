export type WalletCluster = 'devnet' | 'mainnet-beta'

export interface WalletClusterConfig {
  id: WalletCluster
  label: string
  rpcUrl: string
  explorerCluster: string | null
}

export const DEFAULT_WALLET_CLUSTER: WalletCluster = 'devnet'

declare global {
  interface ImportMeta {
    readonly env?: Record<string, string | boolean | undefined>
  }
}

const env = import.meta.env ?? {}

function rpcUrl(key: string, fallback: string): string {
  const value = env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export const WALLET_CLUSTER_OPTIONS: readonly WalletClusterConfig[] = [
  {
    id: 'devnet',
    label: 'Devnet',
    rpcUrl: rpcUrl('WXT_SOLANA_DEVNET_RPC_URL', 'https://api.devnet.solana.com'),
    explorerCluster: 'devnet',
  },
  {
    id: 'mainnet-beta',
    label: 'Mainnet',
    rpcUrl: rpcUrl('WXT_SOLANA_MAINNET_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    explorerCluster: null,
  },
] as const

export function isWalletCluster(value: unknown): value is WalletCluster {
  return typeof value === 'string' && WALLET_CLUSTER_OPTIONS.some((cluster) => cluster.id === value)
}

export function walletClusterConfig(cluster: WalletCluster): WalletClusterConfig {
  return WALLET_CLUSTER_OPTIONS.find((option) => option.id === cluster) ?? WALLET_CLUSTER_OPTIONS[0]!
}

export function explorerTransactionUrl(signature: string, cluster: WalletCluster): string {
  const config = walletClusterConfig(cluster)
  const url = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`
  return config.explorerCluster ? `${url}?cluster=${encodeURIComponent(config.explorerCluster)}` : url
}
