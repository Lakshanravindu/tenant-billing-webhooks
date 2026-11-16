-- 001_billing.sql
-- Tenants' subscription tier, webhook idempotency store and notification outbox.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE subscription_tier AS ENUM ('starter', 'pro', 'enterprise');

CREATE TABLE tenants (
  id                     uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text              NOT NULL,
  subscription_tier      subscription_tier NOT NULL DEFAULT 'starter',
  -- Provider timestamp of the last event applied. Used to ignore events that
  -- arrive out of order (providers don't guarantee delivery order).
  tier_changed_at        timestamptz,
  tier_last_event_id     text,
  created_at             timestamptz       NOT NULL DEFAULT now(),
  updated_at             timestamptz       NOT NULL DEFAULT now()
);

-- Idempotency store. The primary key is what makes processing exactly-once:
-- the row is inserted in the same transaction as the tier update, so either
-- both commit or neither does.
CREATE TABLE webhook_events (
  source        text        NOT NULL,          -- e.g. 'billing'
  event_id      text        NOT NULL,          -- provider's event id
  event_type    text        NOT NULL,
  tenant_id     uuid,
  -- 'processing' only exists inside the open transaction; committed rows
  -- always carry the final outcome.
  outcome       text        NOT NULL DEFAULT 'processing'
                            CHECK (outcome IN ('processing', 'applied', 'ignored', 'stale')),
  payload       jsonb       NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);

CREATE INDEX webhook_events_tenant_idx ON webhook_events (tenant_id, received_at DESC);

-- Transactional outbox. Notifications (email / WhatsApp) are written here in
-- the same transaction and delivered by a separate worker, so we never call a
-- third-party API while holding a DB transaction, and never notify about an
-- upgrade that was rolled back.
CREATE TABLE notification_outbox (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind          text        NOT NULL,
  payload       jsonb       NOT NULL,
  -- One notification per webhook event, even if the worker or handler retries.
  dedupe_key    text        NOT NULL UNIQUE,
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts      integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

CREATE INDEX notification_outbox_pending_idx
  ON notification_outbox (created_at)
  WHERE status = 'pending';

COMMIT;
