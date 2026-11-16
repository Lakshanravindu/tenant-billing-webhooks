import { Pool } from 'pg';
import { createApp } from './app';
import { PgBillingStore } from './billing/pgBillingStore';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });

const app = createApp({
  store: new PgBillingStore(pool),
  // Comma-separated to allow rotating the secret: "new_secret,old_secret".
  secrets: requireEnv('WEBHOOK_SECRET').split(',').map((s) => s.trim()),
  verifyOptions: { toleranceSeconds: Number(process.env.WEBHOOK_TOLERANCE_SECONDS ?? 300) },
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.info(`billing webhooks listening on :${port}`);
});

function shutdown() {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
