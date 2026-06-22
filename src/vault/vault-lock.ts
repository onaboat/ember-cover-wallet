/**
 * True when an error came from the vault being locked (or locked out). The vault
 * throws 'vault is locked' on a sign attempt without a loaded key or after the
 * idle window elapses, and 'vault is locked out' during lockout. A successful
 * unlock does not guarantee a later sign, so callers that sign must re-check.
 */
export function isVaultLockedError(message: string): boolean {
  return message.startsWith('vault is locked')
}
