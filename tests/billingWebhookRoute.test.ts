import request from 'supertest';
import { createApp } from '../src/app';
import { buildSignatureHeader } from '../src/webhooks/signature';
import { billingEvent, NOW, SECRET, TENANT_ID } from './helpers/events';
import { InMemoryBillingStore } from './helpers/inMemoryBillingStore';

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function setup() {
  const store = new InMemoryBillingStore();
  store.addTenant(TENANT_ID, 'starter');
  const app = createApp({ store, secrets: SECRET, verifyOptions: { now: () => NOW }, logger: silentLogger });

  const send = (body: string | object, opts: { signature?: string | null; secret?: string } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(app).post('/api/webhooks/billing').set('content-type', 'application/json');
    const signature =
      opts.signature === undefined ? buildSignatureHeader(opts.secret ?? SECRET, raw, NOW) : opts.signature;
    if (signature !== null) req.set('x-webhook-signature', signature);
    return req.send(raw);
  };

  return { store, app, send };
}

describe('POST /api/webhooks/billing', () => {
  it('200: applies a signed upgrade', async () => {
    const { store, send } = setup();
    const event = billingEvent({ data: { tier: 'enterprise' } });

    const res = await send(event);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      received: true,
      eventId: event.id,
      outcome: 'applied',
      tenantId: TENANT_ID,
      previousTier: 'starter',
      tier: 'enterprise',
    });
    expect(store.tenant(TENANT_ID)!.tier).toBe('enterprise');
  });

  it('200 duplicate: a retried delivery is acknowledged but not re-processed', async () => {
    const { store, send } = setup();
    const event = billingEvent({ data: { tier: 'pro' } });

    await send(event);
    const retry = await send(event);

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ received: true, outcome: 'duplicate' });
    expect(store.outbox).toHaveLength(1);
  });

  it('verifies the signature against the raw bytes, not re-serialised JSON', async () => {
    const { send } = setup();
    // Odd spacing and key order: JSON.stringify(JSON.parse(x)) !== x
    const raw = `{ "type":"subscription.updated",  "id":"evt_raw", "created": ${NOW - 5},
      "data": {"tier":"pro","tenantId":"${TENANT_ID}"} }`;

    const res = await send(raw);

    expect(res.status).toBe(200);
  });

  describe('401', () => {
    it('when the signature header is missing', async () => {
      const { store, send } = setup();
      const res = await send(billingEvent(), { signature: null });
      expect(res.status).toBe(401);
      expect(store.tenant(TENANT_ID)!.tier).toBe('starter');
    });

    it('when signed with the wrong secret', async () => {
      const { send } = setup();
      expect((await send(billingEvent(), { secret: 'wrong' })).status).toBe(401);
    });

    it('when the body was modified after signing', async () => {
      const { send } = setup();
      const signed = JSON.stringify(billingEvent({ data: { tier: 'pro' } }));
      const header = buildSignatureHeader(SECRET, signed, NOW);
      const res = await send(signed.replace('"pro"', '"enterprise"'), { signature: header });
      expect(res.status).toBe(401);
    });

    it('when the signature is expired', async () => {
      const { send } = setup();
      const raw = JSON.stringify(billingEvent());
      const res = await send(raw, { signature: buildSignatureHeader(SECRET, raw, NOW - 3600) });
      expect(res.status).toBe(401);
    });

    it('before parsing: an unsigned garbage body gets 401, not 400', async () => {
      const { send } = setup();
      expect((await send('{not json', { signature: null })).status).toBe(401);
    });
  });

  describe('400', () => {
    it('for a signed body that is not JSON', async () => {
      const { send } = setup();
      const res = await send('{not json');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Body must be valid JSON');
    });

    it.each([
      ['missing id', { ...billingEvent(), id: undefined }],
      ['bad tenant id', billingEvent({ data: { tenantId: 'acme' } })],
      ['unknown tier', billingEvent({ data: { tier: 'platinum' as never } })],
      ['updated without tier', billingEvent({ data: { tier: undefined } })],
    ])('for an invalid payload (%s)', async (_label, body) => {
      const { send } = setup();
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(res.body.issues.length).toBeGreaterThan(0);
    });
  });

  it('404: unknown tenant, and nothing is recorded so a later retry can succeed', async () => {
    const { store, send } = setup();
    const otherTenant = '11111111-2222-4333-8444-555555555555';
    const event = billingEvent({ data: { tenantId: otherTenant } });

    expect((await send(event)).status).toBe(404);

    store.addTenant(otherTenant, 'starter');
    const retry = await send(event);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('applied');
  });

  it('503 with Retry-After on a transient DB error (deadlock)', async () => {
    const { store, send } = setup();
    store.failOn.updateTier = Object.assign(new Error('deadlock detected'), { code: '40P01' });

    const res = await send(billingEvent());

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('500 on an unexpected failure, then succeeds when the provider retries', async () => {
    const { store, send } = setup();
    const event = billingEvent({ data: { tier: 'pro' } });
    store.failOn.enqueueNotification = new Error('disk full');

    expect((await send(event)).status).toBe(500);
    expect(store.tenant(TENANT_ID)!.tier).toBe('starter');

    store.failOn = {};
    const retry = await send(event);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('applied');
    expect(store.tenant(TENANT_ID)!.tier).toBe('pro');
  });

  it('413 for an oversized body', async () => {
    const { send } = setup();
    const res = await send('x'.repeat(300 * 1024), { signature: 'whatever' });
    expect(res.status).toBe(413);
  });

  it('404 for other paths and methods', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/webhooks/billing')).status).toBe(404);
  });
});
