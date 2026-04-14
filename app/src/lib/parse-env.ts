// Vendored .env parser from dotenv (MIT license).
// Parses dotenv-formatted strings into key-value pairs.
// Supports: quoted values, export prefix, comments, multiline (double-quoted \n).

const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm

export function parseEnv(src: string): Record<string, string> {
  const obj: Record<string, string> = {}
  const lines = src.replace(/\r\n?/gm, '\n')

  let match: RegExpExecArray | null
  while ((match = LINE.exec(lines)) != null) {
    const key = match[1]!
    let value = (match[2] || '').trim()
    const maybeQuote = value[0]

    // Remove surrounding quotes
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2')

    // Expand newlines if double quoted
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, '\n')
      value = value.replace(/\\r/g, '\r')
    }

    obj[key] = value
  }

  // Reset regex lastIndex since it's global
  LINE.lastIndex = 0

  return obj
}
