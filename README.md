# tenant-billing-webhooks

Two pieces for a multi-tenant retail/operations SaaS:

1. **`POST /api/webhooks/billing`**: an idempotent webhook handler (Node.js, TypeScript, Express). Billing providers such as Stripe send events that change a tenant's subscription tier (`starter` / `pro` / `enterprise`) and trigger a notification.
2. **AWS CDK stack**: an S3 bucket for tenant document uploads, an SQS ingestion queue, and a least-privilege IAM role for the ingestion worker.

```
src/webhooks/signature.ts          HMAC-SHA256 signature verification (x-webhook-signature)
src/billing/processBillingEvent.ts Idempotent, transactional event processing
src/billing/store.ts               Transaction interface (BillingStore / BillingTx)
src/billing/pgBillingStore.ts      Postgres implementation
src/http/billingWebhookRouter.ts   Route + HTTP status mapping
src/app.ts, src/server.ts          Express app / entry point
db/migrations/001_billing.sql      tenants, webhook_events (idempotency), notification_outbox
infra/lib/document-ingestion-stack.ts   CDK stack
infra/bin/app.ts                        CDK app
tests/                                  Jest tests
```

## Running it

```bash
npm install
npm test               # 63 tests: no database or AWS account needed
npm run typecheck

# webhook service
psql "$DATABASE_URL" -f db/migrations/001_billing.sql
cp .env.example .env
npm run dev

# infrastructure
npx cdk synth          # UPLOAD_ORIGINS=https://app.example.com WORKER_TYPE=ecs|lambda
npx cdk deploy
```

Sending a signed test event:

```bash
BODY='{"id":"evt_1","type":"subscription.updated","created":'$(date +%s)',"data":{"tenantId":"<uuid>","tier":"pro"}}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)
curl -X POST localhost:3000/api/webhooks/billing \
  -H "content-type: application/json" -H "x-webhook-signature: t=$TS,v1=$SIG" -d "$BODY"
```

## Part 1: Webhook handler

### Event shape

```json
{
  "id": "evt_123",
  "type": "subscription.updated",
  "created": 1794787200,
  "data": { "tenantId": "6f1d2c3b-...", "tier": "enterprise" }
}
```

- `subscription.created` and `subscription.updated` set the tier.
- `subscription.deleted` moves the tenant back to `starter`.
- Any other event type is recorded and acknowledged as `ignored`, so the provider stops resending it.

### Signature verification

The header has the form `x-webhook-signature: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. This is the same scheme Stripe uses.

- **Verified against the raw request bytes.** The route uses `express.raw()`. Re-serialising parsed JSON changes whitespace and key order, which would break otherwise valid signatures.
- **Constant-time comparison** with `crypto.timingSafeEqual`.
- **Replay protection.**
  - The timestamp is part of the signed string, so an attacker can't attach a fresh timestamp to an old request.
  - Requests older or newer than 5 minutes are rejected (configurable).
- **Secret rotation.** `WEBHOOK_SECRET` can hold several secrets separated by commas, and a header may carry several `v1` values.
- **Check order.** The signature is checked **before** the body is parsed, so unauthenticated input never reaches the JSON parser or the database.

### Idempotency and atomicity

All of the following happens in **one database transaction**:

```
BEGIN
  INSERT INTO webhook_events (source, event_id, ...) ON CONFLICT DO NOTHING   -- 1. claim
    └─ 0 rows -> already processed -> return "duplicate" (200)
  SELECT ... FROM tenants WHERE id = $1 FOR UPDATE                            -- 2. lock tenant
  UPDATE tenants SET subscription_tier = ...                                  -- 3. apply
  INSERT INTO notification_outbox ... ON CONFLICT (dedupe_key) DO NOTHING     -- 4. notify (outbox)
  UPDATE webhook_events SET outcome = 'applied'
COMMIT
```

- **Why the claim and the update share a transaction.** If the event id were recorded separately (before or after processing), a crash in between would either lose the upgrade or apply it twice. Here the claim and the tier change commit or roll back together.
  - If processing fails, the claim is rolled back too, so the provider's retry processes the event from scratch.
- **Concurrent duplicates.** Providers sometimes deliver the same event twice at the same moment.
  - The second `INSERT` waits on the first transaction's primary-key lock.
  - If the first transaction commits, the second gets `DO NOTHING` and returns `duplicate`.
  - If the first rolls back, the second goes ahead and processes it.
  - No application-level locking is needed.
- **`FOR UPDATE` on the tenant row** makes *different* events for the same tenant run one after another.
- **Out-of-order delivery.** Providers don't guarantee order.
  - `tenants.tier_changed_at` stores the provider timestamp of the last applied event.
  - An older event is recorded as `stale` and doesn't overwrite a newer tier. For example, a late "pro" doesn't undo "enterprise".
- **Notifications go through a transactional outbox.**
  - The handler doesn't call email or WhatsApp APIs. It writes a row to `notification_outbox` in the same transaction, and a separate worker delivers it.
  - So a notification is never sent for an upgrade that rolled back.
  - A slow third-party API never holds a database transaction open.
  - `dedupe_key = billing:<event id>` guarantees at most one notification per event.
  - No notification is queued when the tier doesn't actually change.

### HTTP status codes

Providers retry any response that isn't 2xx. Each status code is chosen so the provider retries exactly when a retry can help.

| Status | When | Provider retries? |
| --- | --- | --- |
| **200** | Applied, duplicate, stale, or ignored event type | No |
| **400** | Body isn't JSON, or doesn't match the schema | Yes, but it won't help. Visible in the provider dashboard. |
| **401** | Missing, invalid or expired signature | Yes, but it won't help |
| **404** | Unknown tenant. Nothing is stored, so a retry after the tenant is provisioned succeeds. | Yes |
| **413** | Body larger than 256 KB | |
| **503** + `Retry-After` | Transient database error (deadlock, serialization failure, connection lost) | Yes |
| **500** | Unexpected error. The transaction was rolled back. | Yes |

**Duplicates return 200, not 409.** A 4xx would make the provider keep retrying an event that has already been handled.

### Code structure

- `processBillingEvent` contains the business logic. It depends only on a small `BillingStore` / `BillingTx` interface.
- `PgBillingStore` is the real implementation.
- The tests use an in-memory store with the same guarantees: changes are all-or-nothing, and transactions run one at a time. That makes rollback, retry and concurrent-duplicate behaviour testable without a database.

## Part 2: CDK stack

`DocumentIngestionStack` sets up: browser upload (presigned URL) → **S3** → *ObjectCreated* event → **SQS** → **ECS task or Lambda worker**.

**S3 bucket**
- SSE-KMS with a customer-managed key (rotation on) and S3 Bucket Keys, which cut KMS calls and cost.
- `BLOCK_ALL` public access, and `BucketOwnerEnforced`, which disables ACLs.
- `enforceSSL`: a bucket policy denies requests without TLS.
- CORS allows `PUT`/`POST`/`GET` only from the configured app origins, for presigned uploads. A `*` origin is rejected when the stack is synthesised.
- Versioning; incomplete multipart uploads are cleaned up after 1 day; old versions expire after 30 days.
- `RETAIN` on delete, so tearing down the stack never deletes customer documents.
- Uploads go under `tenants/<tenantId>/…`, and only that prefix triggers ingestion.

**SQS queue**
- SSE-SQS encryption and TLS only.
- Long polling (20 s).
- Visibility timeout of 15 minutes, which must be longer than the worker's processing time. Otherwise a message reappears while it is still being processed and gets handled twice.
- Dead-letter queue after 5 failed receives, kept for 14 days.

**Worker IAM role and policy (least privilege)**

The actions are written out explicitly instead of using `grantRead()`, which would also add `s3:List*`/`s3:GetBucket*`. The worker doesn't need those: it gets the object key from the queue message.

| Statement | Actions | Resource / condition |
| --- | --- | --- |
| `ReadTenantUploads` | `s3:GetObject`, `s3:GetObjectVersion` | `bucket/tenants/*` only |
| `DecryptViaS3Only` | `kms:Decrypt` | Documents key, only when called through S3 (`kms:ViaService`) |
| `ConsumeIngestionQueue` | `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes`, `GetQueueUrl` | Ingestion queue only, not the DLQ |

- The role trusts only `ecs-tasks.amazonaws.com` (the default) or `lambda.amazonaws.com` (`workerType: 'lambda'`), not both.
- Lambda additionally gets `AWSLambdaBasicExecutionRole` for logs. ECS logs through its execution role instead.
- The worker has no write, delete or send permissions anywhere.

`tests/documentIngestionStack.test.ts` checks all of this against the synthesised template with `aws-cdk-lib/assertions`. For example, it fails if a wildcard action or an S3 write permission appears in the worker policy.

## Not done / next steps

- **Per-tenant S3 isolation inside the worker.** Today the worker can read every tenant's prefix. The next step would be ABAC with session tags (`s3:prefix = tenants/${aws:PrincipalTag/tenantId}/*`), or per-tenant KMS keys for enterprise customers.
- **The outbox delivery worker** (polling with `FOR UPDATE SKIP LOCKED`, retries, then marking rows sent or failed) is described but not implemented.
- **Integration tests** against real Postgres (Testcontainers), to exercise the `ON CONFLICT` / `FOR UPDATE` behaviour with genuinely concurrent connections.
- **Monitoring:** CloudWatch alarms on DLQ depth and on the age of the oldest message in the queue.
- **Retention:** a scheduled job to prune `webhook_events` older than the provider's retry window (e.g. 30 days).
