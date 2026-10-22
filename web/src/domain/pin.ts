// PIN verifiers: "pbkdf2-sha256$<iterations>$<salt>$<hash>" with unpadded
// base64url fields. Mirrors internal/auth/pin.go; tested against
// testdata/vectors/pins.json. Verification runs on the tablet so sign-in and
// manager approvals work offline (docs/decisions/0010).

const SCHEME = 'pbkdf2-sha256';

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function derive(pin: string, salt: Uint8Array, iterations: number, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const out = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    bits,
  );
  return new Uint8Array(out);
}

export function isValidPin(pin: string): boolean {
  return /^[0-9]{4,8}$/.test(pin);
}

/** Checks pin against a verifier; malformed verifiers never match. */
export async function verifyPin(verifier: string, pin: string): Promise<boolean> {
  const parts = verifier.split('$');
  if (parts.length !== 4 || parts[0] !== SCHEME) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  const salt = fromBase64Url(parts[2]!);
  const want = fromBase64Url(parts[3]!);
  if (!salt || !want || want.length === 0) return false;
  const got = await derive(pin, salt, iterations, want.length * 8);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got[i]! ^ want[i]!;
  return diff === 0;
}

/** Creates a verifier (the server does this in production; tests use it for fixtures). */
export async function hashPin(pin: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, iterations, 256);
  return `${SCHEME}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}
