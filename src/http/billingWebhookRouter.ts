import express, { type Request, type Response, Router } from 'express';
import { isTransientDbError } from '../billing/pgBillingStore';
import { processBillingEvent } from '../billing/processBillingEvent';
import type { BillingStore } from '../billing/store';
import { billingEventSchema, TenantNotFoundError } from '../billing/types';
import { SIGNATURE_HEADER, SignatureVerificationError, verifySignature, type VerifyOptions } from '../webhooks/signature';

export interface BillingWebhookDeps {
  store: BillingStore;
  secrets: string | string[];
  verifyOptions?: VerifyOptions;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * POST /api/webhooks/billing
 *
 * Status codes (the provider retries anything that isn't 2xx):
 *   200  processed, ignored, stale or duplicate  -> stop retrying
 *   400  body isn't valid JSON / doesn't match the schema
 *   401  missing, invalid or expired signature
 *   404  tenant doesn't exist (nothing stored, so a later retry can succeed)
 *   503  transient DB problem (deadlock, connection) -> retry
 *   500  anything else -> retry
 */
export function billingWebhookRouter({ store, secrets, verifyOptions, logger = console }: BillingWebhookDeps): Router {
  const router = Router();

  // Signatures are computed over the exact bytes sent, so keep the raw body:
  // re-serialising parsed JSON would change whitespace/key order and break it.
  router.post(
    '/api/webhooks/billing',
    express.raw({ type: () => true, limit: '256kb' }),
    async (req: Request, res: Response) => {
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      // 1. Authenticate before looking at the payload at all.
      try {
        verifySignature(req.get(SIGNATURE_HEADER), rawBody, secrets, verifyOptions);
      } catch (err) {
        if (err instanceof SignatureVerificationError) {
          logger.warn('webhook rejected', { reason: err.reason });
          return res.status(401).json({ error: 'Invalid signature' });
        }
        throw err;
      }

      // 2. Parse and validate.
      let json: unknown;
      try {
        json = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Body must be valid JSON' });
      }

      const parsed = billingEventSchema.safeParse(json);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid event payload',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const event = parsed.data;

      // 3. Process exactly once.
      try {
        const result = await processBillingEvent(store, event);
        logger.info('webhook processed', { eventId: event.id, type: event.type, ...result });
        return res.status(200).json({ received: true, eventId: event.id, ...result });
      } catch (err) {
        if (err instanceof TenantNotFoundError) {
          logger.warn('webhook for unknown tenant', { eventId: event.id, tenantId: err.tenantId });
          return res.status(404).json({ error: 'Tenant not found' });
        }
        if (isTransientDbError(err)) {
          logger.warn('transient failure processing webhook', { eventId: event.id, err });
          return res.status(503).set('Retry-After', '5').json({ error: 'Temporarily unavailable' });
        }
        logger.error('failed to process webhook', { eventId: event.id, err });
        return res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  return router;
}
