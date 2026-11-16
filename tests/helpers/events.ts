import type { BillingEvent } from '../../src/billing/types';

export const TENANT_ID = '6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b';
export const SECRET = 'whsec_test_secret';

/** 2026-11-16T00:00:00Z */
export const NOW = 1_794_787_200;

let counter = 0;

type EventOverrides = Partial<Omit<BillingEvent, 'data'>> & { data?: Partial<BillingEvent['data']> };

export function billingEvent(overrides: EventOverrides = {}): BillingEvent {
  counter += 1;
  return {
    id: `evt_${counter}`,
    type: 'subscription.updated',
    created: NOW - 60,
    ...overrides,
    data: { tenantId: TENANT_ID, tier: 'pro', ...overrides.data },
  };
}
