export interface PasswordAssessment {
  ok: boolean
  reason?: string
}

/** Keep disposable/test wallets easy to access: minimum length only, with no maximum. */
export function assessPassword(password: string): PasswordAssessment {
  if (password.length < 8) {
    return { ok: false, reason: 'Password must be at least 8 characters.' }
  }
  return { ok: true }
}
