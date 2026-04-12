// Encryption utilities for secrets using Web Crypto API (AES-256-GCM).
// Compatible with Cloudflare Workers runtime.

const ALGORITHM = 'AES-GCM'

async function getKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', raw, { name: ALGORITHM }, false, ['encrypt', 'decrypt'])
}

export async function encrypt({
  plaintext,
  encryptionKey,
}: {
  plaintext: string
  encryptionKey: string
}): Promise<{ encrypted: string; iv: string }> {
  const key = await getKey(encryptionKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded)

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv)),
  }
}

export async function decrypt({
  encrypted,
  iv,
  encryptionKey,
}: {
  encrypted: string
  iv: string
  encryptionKey: string
}): Promise<string> {
  const key = await getKey(encryptionKey)
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))

  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv: ivBytes }, key, ciphertext)

  return new TextDecoder().decode(plaintext)
}
