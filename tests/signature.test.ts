import {
  buildSignatureHeader,
  computeSignature,
  SignatureVerificationError,
  verifySignature,
} from '../src/webhooks/signature';
import { NOW, SECRET } from './helpers/events';

const body = Buffer.from('{"id":"evt_1","type":"subscription.updated"}');
const now = () => NOW;

function expectReason(fn: () => void, reason: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SignatureVerificationError);
    expect((err as SignatureVerificationError).reason).toBe(reason);
    return;
  }
  throw new Error('expected verification to fail');
}

describe('webhook signature', () => {
  it('computes HMAC-SHA256 over "<timestamp>.<body>" as lowercase hex', () => {
    // Reference value from: echo -n "1700000000.hello" | openssl dgst -sha256 -hmac secret
    expect(computeSignature('secret', 1_700_000_000, 'hello')).toBe(
      require('node:crypto').createHmac('sha256', 'secret').update('1700000000.hello').digest('hex'),
    );
    expect(computeSignature('secret', 1, 'x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a valid signature', () => {
    const header = buildSignatureHeader(SECRET, body, NOW);
    expect(() => verifySignature(header, body, SECRET, { now })).not.toThrow();
  });

  it('accepts a timestamp inside the tolerance window', () => {
    const header = buildSignatureHeader(SECRET, body, NOW - 299);
    expect(() => verifySignature(header, body, SECRET, { now, toleranceSeconds: 300 })).not.toThrow();
  });

  it('rejects a missing header', () => {
    expectReason(() => verifySignature(undefined, body, SECRET, { now }), 'missing header');
    expectReason(() => verifySignature('', body, SECRET, { now }), 'missing header');
  });

  it('rejects a tampered body', () => {
    const header = buildSignatureHeader(SECRET, body, NOW);
    const tampered = Buffer.from(body.toString().replace('updated', 'deleted'));
    expectReason(() => verifySignature(header, tampered, SECRET, { now }), 'signature mismatch');
  });

  it('rejects a signature made with a different secret', () => {
    const header = buildSignatureHeader('someone_else', body, NOW);
    expectReason(() => verifySignature(header, body, SECRET, { now }), 'signature mismatch');
  });

  it('rejects a replayed request with a swapped timestamp', () => {
    const original = buildSignatureHeader(SECRET, body, NOW - 3600);
    const replayed = original.replace(/t=\d+/, `t=${NOW}`);
    expectReason(() => verifySignature(replayed, body, SECRET, { now }), 'signature mismatch');
  });

  it.each([
    ['too old', NOW - 301],
    ['in the future', NOW + 301],
  ])('rejects a timestamp %s', (_label, ts) => {
    const header = buildSignatureHeader(SECRET, body, ts);
    expectReason(() => verifySignature(header, body, SECRET, { now }), 'timestamp outside tolerance');
  });

  it.each([
    ['no timestamp', `v1=${'a'.repeat(64)}`, 'missing or invalid timestamp'],
    ['non-numeric timestamp', `t=abc,v1=${'a'.repeat(64)}`, 'missing or invalid timestamp'],
    ['no v1', `t=${NOW}`, 'no v1 signature'],
    ['short v1', `t=${NOW},v1=abc123`, 'no v1 signature'],
    ['garbage', 'not-a-signature', 'missing or invalid timestamp'],
  ])('rejects a malformed header (%s)', (_label, header, reason) => {
    expectReason(() => verifySignature(header, body, SECRET, { now }), reason);
  });

  it('supports secret rotation (any configured secret may match)', () => {
    const header = buildSignatureHeader('old_secret', body, NOW);
    expect(() => verifySignature(header, body, ['new_secret', 'old_secret'], { now })).not.toThrow();
  });

  it('accepts a header carrying several v1 signatures if one matches', () => {
    const good = computeSignature(SECRET, NOW, body);
    const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${good}`;
    expect(() => verifySignature(header, body, SECRET, { now })).not.toThrow();
  });

  it('refuses to verify when no secret is configured', () => {
    const header = buildSignatureHeader(SECRET, body, NOW);
    expect(() => verifySignature(header, body, [], { now })).toThrow('No webhook secret configured');
  });
});
