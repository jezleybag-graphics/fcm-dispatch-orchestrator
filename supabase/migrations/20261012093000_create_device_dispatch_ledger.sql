-- Migration: 20261012093000_create_device_dispatch_ledger.sql
-- Purpose: Establish role-isolated device token registry and append-only dispatch journal.
--
-- ARCHITECTURAL NOTE:
-- Do NOT use `CREATE TABLE IF NOT EXISTS` in migrations. Against an existing database,
-- `IF NOT EXISTS` silently passes even when an older table has drifted from the expected
-- column types, nullability rules, or composite unique constraints, turning deployment-time
-- schema mismatches into silent runtime data corruption. Migrations must fail loudly if
-- database state does not match the expected baseline.

BEGIN;

CREATE TYPE app_surface_role AS ENUM (
  'pos_terminal',
  'kitchen_display',
  'manager_console',
  'rider_dispatcher',
  'customer_storefront'
);

CREATE TYPE token_health_status AS ENUM (
  'active',
  'unregistered',
  'quarantined'
);

CREATE TABLE public.device_token_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  account_id UUID NOT NULL,
  device_fingerprint TEXT NOT NULL,
  surface_role app_surface_role NOT NULL,
  fcm_token TEXT NOT NULL,
  status token_health_status NOT NULL DEFAULT 'active',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent shared store tablets and personal phones under the same account_id
  -- from overwriting each other's push registration across different app surfaces.
  CONSTRAINT uq_tenant_device_surface UNIQUE (tenant_id, device_fingerprint, surface_role)
);

CREATE INDEX idx_device_registry_active_lookup
  ON public.device_token_registry (tenant_id, surface_role)
  WHERE status = 'active';

CREATE TABLE public.dispatch_audit_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_surface app_surface_role NOT NULL,
  total_tokens_targeted INTEGER NOT NULL CHECK (total_tokens_targeted >= 0),
  batches_dispatched INTEGER NOT NULL CHECK (batches_dispatched >= 0),
  unregistered_tokens_pruned INTEGER NOT NULL DEFAULT 0 CHECK (unregistered_tokens_pruned >= 0),
  dry_run BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE public.device_token_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_audit_journal ENABLE ROW LEVEL SECURITY;

COMMIT;
