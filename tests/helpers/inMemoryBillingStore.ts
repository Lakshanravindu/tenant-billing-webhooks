import type { BillingStore, BillingTx, ClaimEventInput, OutboxMessage, TenantSubscription } from '../../src/billing/store';
import type { EventOutcome, Tier } from '../../src/billing/types';

interface State {
  tenants: Map<string, TenantSubscription & { lastEventId?: string }>;
  events: Map<string, ClaimEventInput & { outcome: EventOutcome | 'processing' }>;
  outbox: Map<string, OutboxMessage>;
}

function clone(state: State): State {
  return {
    tenants: new Map([...state.tenants].map(([k, v]) => [k, { ...v }])),
    events: new Map([...state.events].map(([k, v]) => [k, { ...v }])),
    outbox: new Map([...state.outbox].map(([k, v]) => [k, { ...v }])),
  };
}

/**
 * Test double with the guarantees the real store relies on:
 * - all-or-nothing transactions (work happens on a copy, swapped in on commit)
 * - transactions run one at a time, like two requests contending for the same
 *   webhook_events primary key / tenant row lock in Postgres.
 *
 * `failOn` makes a given operation throw so rollback paths can be tested.
 */
export class InMemoryBillingStore implements BillingStore {
  state: State = { tenants: new Map(), events: new Map(), outbox: new Map() };
  failOn: Partial<Record<keyof BillingTx, Error>> = {};
  private queue: Promise<unknown> = Promise.resolve();

  addTenant(id: string, tier: Tier = 'starter', tierChangedAt: Date | null = null) {
    this.state.tenants.set(id, { id, tier, tierChangedAt });
  }

  tenant(id: string) {
    return this.state.tenants.get(id);
  }

  get outbox() {
    return [...this.state.outbox.values()];
  }

  event(id: string, source = 'billing') {
    return this.state.events.get(`${source}:${id}`);
  }

  transaction<T>(fn: (tx: BillingTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const draft = clone(this.state);
      const result = await fn(this.txFor(draft));
      this.state = draft; // commit
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private txFor(s: State): BillingTx {
    const maybeFail = (op: keyof BillingTx) => {
      const err = this.failOn[op];
      if (err) throw err;
    };
    // Yield between steps so concurrently started transactions really interleave
    // at the await points if serialisation were ever removed.
    const tick = () => new Promise((r) => setImmediate(r));

    return {
      claimEvent: async (input) => {
        await tick();
        maybeFail('claimEvent');
        const key = `${input.source}:${input.eventId}`;
        if (s.events.has(key)) return false;
        s.events.set(key, { ...input, outcome: 'processing' });
        return true;
      },
      completeEvent: async (source, eventId, outcome) => {
        maybeFail('completeEvent');
        s.events.get(`${source}:${eventId}`)!.outcome = outcome;
      },
      lockTenant: async (tenantId) => {
        await tick();
        maybeFail('lockTenant');
        const t = s.tenants.get(tenantId);
        return t ? { id: t.id, tier: t.tier, tierChangedAt: t.tierChangedAt } : null;
      },
      updateTier: async (tenantId, tier, changedAt, eventId) => {
        await tick();
        maybeFail('updateTier');
        const t = s.tenants.get(tenantId)!;
        Object.assign(t, { tier, tierChangedAt: changedAt, lastEventId: eventId });
      },
      enqueueNotification: async (message) => {
        maybeFail('enqueueNotification');
        if (!s.outbox.has(message.dedupeKey)) s.outbox.set(message.dedupeKey, message);
      },
    };
  }
}
