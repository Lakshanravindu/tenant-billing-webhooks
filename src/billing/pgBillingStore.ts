import type { Pool, PoolClient } from 'pg';
import type { BillingStore, BillingTx, ClaimEventInput, OutboxMessage, TenantSubscription } from './store';
import type { EventOutcome, Tier } from './types';

class PgBillingTx implements BillingTx {
  constructor(private readonly client: PoolClient) {}

  async claimEvent(input: ClaimEventInput): Promise<boolean> {
    // If another transaction is processing the same event right now, this
    // INSERT waits on its row lock. When that one commits we get DO NOTHING
    // (duplicate); if it rolls back, our insert goes through and we process it.
    const res = await this.client.query(
      `INSERT INTO webhook_events (source, event_id, event_type, tenant_id, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, event_id) DO NOTHING`,
      [input.source, input.eventId, input.eventType, input.tenantId, JSON.stringify(input.payload)],
    );
    return res.rowCount === 1;
  }

  async completeEvent(source: string, eventId: string, outcome: EventOutcome): Promise<void> {
    await this.client.query(
      'UPDATE webhook_events SET outcome = $3 WHERE source = $1 AND event_id = $2',
      [source, eventId, outcome],
    );
  }

  async lockTenant(tenantId: string): Promise<TenantSubscription | null> {
    const res = await this.client.query<{ id: string; tier: Tier; tier_changed_at: Date | null }>(
      `SELECT id, subscription_tier AS tier, tier_changed_at
       FROM tenants
       WHERE id = $1
       FOR UPDATE`,
      [tenantId],
    );
    const row = res.rows[0];
    return row ? { id: row.id, tier: row.tier, tierChangedAt: row.tier_changed_at } : null;
  }

  async updateTier(tenantId: string, tier: Tier, changedAt: Date, eventId: string): Promise<void> {
    await this.client.query(
      `UPDATE tenants
       SET subscription_tier = $2, tier_changed_at = $3, tier_last_event_id = $4, updated_at = now()
       WHERE id = $1`,
      [tenantId, tier, changedAt, eventId],
    );
  }

  async enqueueNotification(message: OutboxMessage): Promise<void> {
    await this.client.query(
      `INSERT INTO notification_outbox (tenant_id, kind, payload, dedupe_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [message.tenantId, message.kind, JSON.stringify(message.payload), message.dedupeKey],
    );
  }
}

export class PgBillingStore implements BillingStore {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: BillingTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgBillingTx(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// Postgres errors where retrying the same request can succeed.
const TRANSIENT_PG_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57P01', // admin_shutdown
  '53300', // too_many_connections
]);

export function isTransientDbError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return TRANSIENT_PG_CODES.has(code) || code.startsWith('08') /* connection exceptions */ || code === 'ECONNREFUSED';
}
