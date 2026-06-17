import type { WalletIcon } from '@wallet-standard/core'

// Minimal ember flame mark; replace with brand asset later. Must be a data: URI.
export const icon =
  `data:image/svg+xml;base64,${btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#0b0b0f"/>' +
      '<path d="M16 6c3 4 6 6 6 11a6 6 0 1 1-12 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4 0-7 2-10Z" fill="#ff5a1f"/>' +
    '</svg>',
  )}` as WalletIcon
