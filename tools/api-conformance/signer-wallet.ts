const PRODUCT_WALLET_NAME = 'Ember'
const MAX_WALLET_NAME_LENGTH = 80

/**
 * Keep the SDK lifecycle runner outside the Ember product's decision boundary.
 * Ember owns cover review for every request it signs, so using it as the
 * runner's signer would create a second decision for the same transaction.
 */
export function parseConformanceSignerWalletName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('EMBER_CONFORMANCE_SIGNER_WALLET_NAME is required')
  }
  const walletName = value.trim()
  if (walletName.length > MAX_WALLET_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(walletName)) {
    throw new Error('EMBER_CONFORMANCE_SIGNER_WALLET_NAME is invalid')
  }
  if (walletName.localeCompare(PRODUCT_WALLET_NAME, undefined, { sensitivity: 'base' }) === 0) {
    throw new Error(
      'Ember cannot be the SDK conformance signer because it owns its own cover decision flow',
    )
  }
  return walletName
}
