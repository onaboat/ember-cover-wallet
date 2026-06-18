export type WalletCluster = 'devnet' | 'mainnet-beta'

export interface WalletClusterConfig {
  id: WalletCluster
  label: string
  rpcUrl: string
  explorerCluster: string | null
}

export const DEFAULT_WALLET_CLUSTER: WalletCluster = 'devnet'

export const WALLET_CLUSTER_OPTIONS: readonly WalletClusterConfig[] = [
  {
    id: 'devnet',
    label: 'Devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    explorerCluster: 'devnet',
  },
  {
    id: 'mainnet-beta',
    label: 'Mainnet',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
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
