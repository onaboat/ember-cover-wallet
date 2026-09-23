function hostFromOrigin(origin: string | undefined): string | null {
  if (!origin) {
    return null
  }
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

function hostsFromMessage(message: string): string[] {
  const hosts = new Set<string>()
  for (const match of message.matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)) {
    try {
      hosts.add(new URL(match[0]).host.toLowerCase())
    } catch {
      // Ignore text that looks like a URL but is not valid enough to compare.
    }
  }
  for (const match of message.matchAll(/^\s*(domain|uri):\s*([^\s]+)\s*$/gim)) {
    const value = match[2] ?? ''
    try {
      hosts.add(new URL(value.startsWith('http') ? value : `https://${value}`).host.toLowerCase())
    } catch {
      // Ignore non-host values.
    }
  }
  return [...hosts]
}

export function messageRisk(message: string, origin: string | undefined): { requiresAck: boolean; warning: string | null } {
  if (message.startsWith('0x') || message.length > 500) {
    return {
      requiresAck: true,
      warning: 'This message is not human-readable or is unusually long.',
    }
  }
  const originHost = hostFromOrigin(origin)
  const mismatchedHost = originHost ? hostsFromMessage(message).find((host) => host !== originHost) : null
  if (mismatchedHost) {
    return {
      requiresAck: true,
      warning: 'This message references a different site.',
    }
  }
  if (/\b(authorize|permission|delegate|sign in|login|access|session|nonce|withdraw|transfer)\b/i.test(message)) {
    return {
      requiresAck: true,
      warning: 'This message may authorize access with this site.',
    }
  }
  return { requiresAck: false, warning: null }
}

