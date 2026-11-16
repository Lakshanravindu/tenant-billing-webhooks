import { z } from 'zod';

export const TIERS = ['starter', 'pro', 'enterprise'] as const;
export type Tier = (typeof TIERS)[number];

export const HANDLED_EVENT_TYPES = [
  'subscription.created',
  'subscription.updated',
  'subscription.deleted',
] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export const billingEventSchema = z
  .object({
    id: z.string().min(1).max(255),
    type: z.string().min(1).max(100),
    /** Unix seconds, set by the provider when the event happened. */
    created: z.number().int().positive(),
    data: z.object({
      tenantId: z.uuid(),
      tier: z.enum(TIERS).optional(),
    }),
  })
  .superRefine((event, ctx) => {
    const needsTier = event.type === 'subscription.created' || event.type === 'subscription.updated';
    if (needsTier && !event.data.tier) {
      ctx.addIssue({ code: 'custom', path: ['data', 'tier'], message: `tier is required for ${event.type}` });
    }
  });

export type BillingEvent = z.infer<typeof billingEventSchema>;

export function isHandledEventType(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

export type EventOutcome = 'applied' | 'ignored' | 'stale';

export interface ProcessResult {
  outcome: EventOutcome | 'duplicate';
  tenantId?: string;
  previousTier?: Tier;
  tier?: Tier;
}

export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} not found`);
    this.name = 'TenantNotFoundError';
  }
}
