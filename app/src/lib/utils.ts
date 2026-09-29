import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ── Time formatting ─────────────────────────────────────────────────
//
// LESSON — both of these take `now` and `timeZone` as REQUIRED arguments on
// purpose. They used to read `Date.now()` and the ambient timezone directly,
// which made every caller a React hydration bug:
//
//   timezone  the worker renders in UTC, the browser renders in the user's
//             zone. For a user at UTC+2, any timestamp between 22:00 and
//             00:00 UTC formats as a DIFFERENT CALENDAR DAY on each side.
//             That was 22 of the 40 most recent rows in production — so it
//             was not only a hydration mismatch (React error #418), it also
//             showed the wrong date to the user.
//   Date.now  the server's clock at SSR is not the client's clock at
//             hydration, so a relative bucket can flip between the two.
//
// Never add defaults here. Making the caller pass both is what forces the
// server and the client to agree; see `<TimeAgo>` for the render-time gate.

export function formatAbsoluteDate({ ts, timeZone }: { ts: number; timeZone: string }) {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  })
}

export function formatTime({ ts, now, timeZone }: { ts: number; now: number; timeZone: string }) {
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return formatAbsoluteDate({ ts, timeZone })
}

// Short label for a session's user agent: the CLI and its version, a browser
// and its OS, or else the client's own name (curl/8.15.0)
// An IPv6 address written short, the usual way: leading zeros dropped and the
// longest run of zero groups as ::. better-auth keeps only the /64 network of
// a login, written out in full, which doesn't fit a table column. IPv4 as is.
export function formatIp(ip: string | null): string | null {
  if (!ip || !ip.includes(':') || ip.includes('::')) return ip
  const groups = ip.toLowerCase().split(':').map((group) => group.replace(/^0+(?=.)/, ''))
  let best = { start: -1, length: 1 }
  for (let i = 0; i < groups.length; i++) {
    let end = i
    while (end < groups.length && groups[end] === '0') end++
    if (end - i > best.length) best = { start: i, length: end - i }
  }
  if (best.start < 0) return groups.join(':')
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.length).join(':')}`
}

export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'
  const cli = /^sigillo-cli\/(\S+)/.exec(userAgent)
  if (cli) return `Sigillo CLI ${cli[1]}`
  // Order matters: Edge also says Chrome, Chrome also says Safari, Android
  // also says Linux, and iOS also says Mac OS X
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : null
  if (!browser) return userAgent.split(' ')[0]!
  const os = /Windows/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : null
  return os ? `${browser} on ${os}` : browser
}

// ── Email domain helpers (client-safe) ──────────────────────────────
// These are used by both server code (db.ts, actions.ts) and client
// components (create-org-form, settings-page), so they must not import
// any server-only modules like cloudflare:workers or drizzle.

// Public email providers where auto-join makes no sense (anyone can register).
// Used to hide the auto-join checkbox in the create-org form and to block
// setting autoJoinDomain in the createOrgAction.
export const COMMON_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.fr',
  'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me',
  'aol.com',
  'mail.com',
  'zoho.com',
  'yandex.com', 'yandex.ru',
  'tutanota.com', 'tuta.com',
  'fastmail.com',
  'hey.com',
  'pm.me',
  'qq.com',
  '163.com',
  '126.com',
  'gmx.com', 'gmx.net',
  'web.de',
  'mail.ru',
])

export function getEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at === -1) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain || null
}

// ── Secret names and .env rendering (client-safe) ────────────────────
// New secret names must be valid shell/env identifiers. A name with a
// newline or "=" used to inject extra lines into env/docker/yaml downloads.
export const SECRET_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

export function getSecretNameError(name: string): string | null {
  if (SECRET_NAME_REGEX.test(name)) return null
  return `Invalid secret name "${name}". Use letters, digits and underscores, not starting with a digit.`
}

// Names safe to emit as a line key in text formats. Looser than
// SECRET_NAME_REGEX (dotenv key grammar) so legacy names like
// "my-api-key" still download; anything else is dropped.
export function isRenderableSecretName(name: string) {
  return /^[\w.-]+$/.test(name)
}

// Quote a value so `source .env` never expands $(...), `...` or $VAR,
// while staying readable by dotenv parsers whenever possible:
// - no single quote: '...' (literal in both shell and dotenv)
// - single quote but nothing shell-special: "..." (literal in both)
// - otherwise: shell '\'' escaping (correct for shell; dotenv can't
//   represent a value with both ' and $/`/"/\ losslessly anyway)
export function quoteEnvValue(value: string) {
  if (!value.includes("'")) return `'${value}'`
  if (!/["$`\\]/.test(value)) return `"${value}"`
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function renderEnvFile(entries: Iterable<[string, string]>) {
  const lines: string[] = []
  for (const [name, value] of entries) {
    if (!isRenderableSecretName(name)) continue
    lines.push(`${name}=${quoteEnvValue(value)}`)
  }
  return lines.join('\n') + '\n'
}
