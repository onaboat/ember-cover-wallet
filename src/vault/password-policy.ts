export interface PasswordAssessment {
  ok: boolean
  reason?: string
}

const CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]

/** Reject anything under 12 chars or mixing fewer than 3 character classes. */
export function assessPassword(password: string): PasswordAssessment {
  if (password.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters.' }
  }
  const classes = CLASSES.filter((re) => re.test(password)).length
  if (classes < 3) {
    return { ok: false, reason: 'Password must mix at least 3 of: lowercase, uppercase, digits, symbols.' }
  }
  return { ok: true }
}
