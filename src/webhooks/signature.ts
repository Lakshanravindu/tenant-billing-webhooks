import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-webhook-signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export class SignatureVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`Webhook signature verification failed: ${reason}`);
    this.name = 'SignatureVerificationError';
  }
}

/**
 * Header format (same shape Stripe uses):
 *
 *   x-webhook-signature: t=1731744000,v1=5257a869e7ec...
 *
 * v1 = hex(HMAC-SHA256(secret, `${t}.${rawBody}`))
 *
 * Signing the timestamp together with the body stops an attacker from replaying
 * an old captured request with a fresh timestamp.
 */
export function computeSignature(secret: string, timestamp: number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export function buildSignatureHeader(secret: string, rawBody: Buffer | string, timestamp: number): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseHeader(header: string): ParsedHeader {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }

  if (timestamp === undefined) throw new SignatureVerificationError('missing or invalid timestamp');
  if (signatures.length === 0) throw new SignatureVerificationError('no v1 signature');
  return { timestamp, signatures };
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Current unix time in seconds; injectable for tests. */
  now?: () => number;
}

/**
 * Throws SignatureVerificationError unless the header carries a valid,
 * fresh signature for `rawBody` under one of `secrets`.
 *
 * Several secrets are accepted so the shared secret can be rotated without
 * downtime; several v1 values are accepted for the same reason on the sender side.
 */
export function verifySignature(
  header: string | undefined,
  rawBody: Buffer,
  secrets: string | string[],
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = () => Math.floor(Date.now() / 1000) }: VerifyOptions = {},
): void {
  if (!header) throw new SignatureVerificationError('missing header');

  const { timestamp, signatures } = parseHeader(header);

  if (Math.abs(now() - timestamp) > toleranceSeconds) {
    throw new SignatureVerificationError('timestamp outside tolerance');
  }

  const candidates = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  if (candidates.length === 0) throw new Error('No webhook secret configured');

  const valid = candidates.some((secret) => {
    const expected = computeSignature(secret, timestamp, rawBody);
    return signatures.some((sig) => safeEqualHex(sig, expected));
  });

  if (!valid) throw new SignatureVerificationError('signature mismatch');
}
