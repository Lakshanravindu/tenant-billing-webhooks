import type { BillingStore } from './store';
import { isHandledEventType, TenantNotFoundError, type BillingEvent, type ProcessResult, type Tier } from './types';

export const WEBHOOK_SOURCE = 'billing';

/**
 * Applies a verified billing event exactly once.
 *
 * Everything happens in one transaction:
 *   1. claim the event id in the idempotency store (duplicate -> stop)
 *   2. lock the tenant row
 *   3. update the tier (unless the event is older than the last one applied)
 *   4. write a notification to the outbox
 *
 * If anything throws, the whole transaction rolls back, including the claim,
 * so the provider's retry will process the event from scratch.
 */
export async function processBillingEvent(store: BillingStore, event: BillingEvent): Promise<ProcessResult> {
  const tenantId = event.data.tenantId;

  return store.transaction(async (tx) => {
    const claimed = await tx.claimEvent({
      source: WEBHOOK_SOURCE,
      eventId: event.id,
      eventType: event.type,
      tenantId,
      payload: event,
    });
    if (!claimed) return { outcome: 'duplicate' };

    if (!isHandledEventType(event.type)) {
      // Acknowledge and record it so the provider stops retrying.
      await tx.completeEvent(WEBHOOK_SOURCE, event.id, 'ignored');
      return { outcome: 'ignored', tenantId };
    }

    const tenant = await tx.lockTenant(tenantId);
    if (!tenant) throw new TenantNotFoundError(tenantId);

    // Providers don't guarantee ordering. A late "updated to pro" must not
    // overwrite a newer "updated to enterprise".
    const eventTime = new Date(event.created * 1000);
    if (tenant.tierChangedAt && eventTime < tenant.tierChangedAt) {
      await tx.completeEvent(WEBHOOK_SOURCE, event.id, 'stale');
      return { outcome: 'stale', tenantId, previousTier: tenant.tier, tier: tenant.tier };
    }

    const newTier: Tier = event.type === 'subscription.deleted' ? 'starter' : event.data.tier!;
    await tx.updateTier(tenantId, newTier, eventTime, event.id);

    if (newTier !== tenant.tier) {
      await tx.enqueueNotification({
        tenantId,
        kind: 'subscription.tier_changed',
        payload: { from: tenant.tier, to: newTier, eventId: event.id },
        dedupeKey: `${WEBHOOK_SOURCE}:${event.id}`,
      });
    }

    await tx.completeEvent(WEBHOOK_SOURCE, event.id, 'applied');
    return { outcome: 'applied', tenantId, previousTier: tenant.tier, tier: newTier };
  });
}
