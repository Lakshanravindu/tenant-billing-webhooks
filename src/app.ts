import express, { type ErrorRequestHandler } from 'express';
import { billingWebhookRouter, type BillingWebhookDeps } from './http/billingWebhookRouter';

export function createApp(deps: BillingWebhookDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(billingWebhookRouter(deps));

  // Body parser errors (payload too large, bad encoding) carry their own status.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) (deps.logger ?? console).error('unhandled error', err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  };
  app.use(onError);

  return app;
}
