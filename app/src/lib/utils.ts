import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Thrown by the server when an action needs a passkey assertion and got none.
// The browser reads it to open the passkey prompt and try again.
export const PASSKEY_REQUIRED_MESSAGE = 'Passkey confirmation required'

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

// Max env description length, shared by API, server action, and textarea.
export const ENV_DESCRIPTION_MAX_LENGTH = 1000

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
