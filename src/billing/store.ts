import type { EventOutcome, Tier } from './types';

export interface TenantSubscription {
  id: string;
  tier: Tier;
  tierChangedAt: Date | null;
}

export interface ClaimEventInput {
  source: string;
  eventId: string;
  eventType: string;
  tenantId: string | null;
  payload: unknown;
}

export interface OutboxMessage {
  tenantId: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

/** Operations available inside one database transaction. */
export interface BillingTx {
  /**
   * Inserts the event into the idempotency store.
   * Returns false if it was already there (i.e. this is a retry/duplicate).
   */
  claimEvent(input: ClaimEventInput): Promise<boolean>;
  completeEvent(source: string, eventId: string, outcome: EventOutcome): Promise<void>;
  /** SELECT ... FOR UPDATE so concurrent events for one tenant are serialised. */
  lockTenant(tenantId: string): Promise<TenantSubscription | null>;
  updateTier(tenantId: string, tier: Tier, changedAt: Date, eventId: string): Promise<void>;
  enqueueNotification(message: OutboxMessage): Promise<void>;
}

export interface BillingStore {
  /** Runs `fn` in a transaction: commit on success, rollback if it throws. */
  transaction<T>(fn: (tx: BillingTx) => Promise<T>): Promise<T>;
}
