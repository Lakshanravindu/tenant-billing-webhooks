import { processBillingEvent } from '../src/billing/processBillingEvent';
import { TenantNotFoundError } from '../src/billing/types';
import { billingEvent, NOW, TENANT_ID } from './helpers/events';
import { InMemoryBillingStore } from './helpers/inMemoryBillingStore';

describe('processBillingEvent', () => {
  let store: InMemoryBillingStore;

  beforeEach(() => {
    store = new InMemoryBillingStore();
    store.addTenant(TENANT_ID, 'starter');
  });

  it('upgrades the tier, records the event and queues one notification', async () => {
    const event = billingEvent({ data: { tier: 'pro' } });

    const result = await processBillingEvent(store, event);

    expect(result).toEqual({ outcome: 'applied', tenantId: TENANT_ID, previousTier: 'starter', tier: 'pro' });
    expect(store.tenant(TENANT_ID)).toMatchObject({ tier: 'pro', tierChangedAt: new Date(event.created * 1000) });
    expect(store.event(event.id)?.outcome).toBe('applied');
    expect(store.outbox).toEqual([
      {
        tenantId: TENANT_ID,
        kind: 'subscription.tier_changed',
        payload: { from: 'starter', to: 'pro', eventId: event.id },
        dedupeKey: `billing:${event.id}`,
      },
    ]);
  });

  describe('idempotency', () => {
    it('does not process a retried event twice', async () => {
      const event = billingEvent({ data: { tier: 'enterprise' } });

      await processBillingEvent(store, event);
      // Simulate an admin downgrade in between: a replay must not re-upgrade.
      store.tenant(TENANT_ID)!.tier = 'pro';
      const retry = await processBillingEvent(store, event);

      expect(retry).toEqual({ outcome: 'duplicate' });
      expect(store.tenant(TENANT_ID)!.tier).toBe('pro');
      expect(store.outbox).toHaveLength(1);
    });

    it('processes concurrent deliveries of the same event exactly once', async () => {
      const event = billingEvent({ data: { tier: 'enterprise' } });

      const results = await Promise.all([
        processBillingEvent(store, event),
        processBillingEvent(store, event),
        processBillingEvent(store, event),
      ]);

      expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'duplicate', 'duplicate']);
      expect(store.outbox).toHaveLength(1);
    });

    it('treats the same id from the provider as one event even if the body differs', async () => {
      await processBillingEvent(store, billingEvent({ id: 'evt_same', data: { tier: 'pro' } }));
      const second = await processBillingEvent(store, billingEvent({ id: 'evt_same', data: { tier: 'enterprise' } }));

      expect(second.outcome).toBe('duplicate');
      expect(store.tenant(TENANT_ID)!.tier).toBe('pro');
    });
  });

  describe('atomicity', () => {
    it.each(['updateTier', 'enqueueNotification', 'completeEvent'] as const)(
      'rolls everything back if %s fails, so a retry processes the event',
      async (op) => {
        const event = billingEvent({ data: { tier: 'pro' } });
        store.failOn[op] = new Error('db blew up');

        await expect(processBillingEvent(store, event)).rejects.toThrow('db blew up');

        // Nothing committed: no claim, no tier change, no notification.
        expect(store.event(event.id)).toBeUndefined();
        expect(store.tenant(TENANT_ID)!.tier).toBe('starter');
        expect(store.outbox).toHaveLength(0);

        // Provider retries after the DB recovers.
        store.failOn = {};
        await expect(processBillingEvent(store, event)).resolves.toMatchObject({ outcome: 'applied' });
        expect(store.tenant(TENANT_ID)!.tier).toBe('pro');
        expect(store.outbox).toHaveLength(1);
      },
    );

    it('does not record the event when the tenant is unknown', async () => {
      const event = billingEvent({ data: { tenantId: '00000000-0000-4000-8000-000000000000' } });

      await expect(processBillingEvent(store, event)).rejects.toBeInstanceOf(TenantNotFoundError);
      expect(store.event(event.id)).toBeUndefined();
    });
  });

  describe('ordering', () => {
    it('ignores an event older than the last applied change', async () => {
      const newer = billingEvent({ created: NOW - 10, data: { tier: 'enterprise' } });
      const older = billingEvent({ created: NOW - 100, data: { tier: 'pro' } });

      await processBillingEvent(store, newer);
      const result = await processBillingEvent(store, older);

      expect(result.outcome).toBe('stale');
      expect(store.tenant(TENANT_ID)!.tier).toBe('enterprise');
      expect(store.event(older.id)?.outcome).toBe('stale');
      expect(store.outbox).toHaveLength(1);
    });

    it('applies events in order when they arrive in order', async () => {
      await processBillingEvent(store, billingEvent({ created: NOW - 100, data: { tier: 'pro' } }));
      await processBillingEvent(store, billingEvent({ created: NOW - 10, data: { tier: 'enterprise' } }));

      expect(store.tenant(TENANT_ID)!.tier).toBe('enterprise');
      expect(store.outbox.map((m) => m.payload)).toEqual([
        expect.objectContaining({ from: 'starter', to: 'pro' }),
        expect.objectContaining({ from: 'pro', to: 'enterprise' }),
      ]);
    });
  });

  it('downgrades to starter when the subscription is deleted', async () => {
    store.addTenant(TENANT_ID, 'enterprise');

    const result = await processBillingEvent(store, billingEvent({ type: 'subscription.deleted', data: { tier: undefined } }));

    expect(result).toMatchObject({ outcome: 'applied', previousTier: 'enterprise', tier: 'starter' });
    expect(store.outbox[0]!.payload).toMatchObject({ from: 'enterprise', to: 'starter' });
  });

  it('does not notify when the tier does not actually change', async () => {
    store.addTenant(TENANT_ID, 'pro');

    const result = await processBillingEvent(store, billingEvent({ data: { tier: 'pro' } }));

    expect(result.outcome).toBe('applied');
    expect(store.outbox).toHaveLength(0);
  });

  it('records and acknowledges event types it does not handle', async () => {
    const event = billingEvent({ type: 'invoice.paid' });

    const result = await processBillingEvent(store, event);

    expect(result).toEqual({ outcome: 'ignored', tenantId: TENANT_ID });
    expect(store.event(event.id)?.outcome).toBe('ignored');
    expect(store.tenant(TENANT_ID)!.tier).toBe('starter');
    expect(await processBillingEvent(store, event)).toEqual({ outcome: 'duplicate' });
  });
});
