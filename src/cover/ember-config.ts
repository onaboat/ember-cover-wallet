export interface EmberConfig {
  /** Base URL of the apps/api Worker proxy (never the Ember API directly). */
  proxyBaseUrl: string
  cluster: 'devnet' | 'mainnet'
  /** Pre-sign sits in the signing path; fail open past this. */
  preSignTimeoutMs: number
}
