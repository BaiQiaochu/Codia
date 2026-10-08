-- Standalone PostgreSQL target schema. This migration has NOT been applied by
-- the application. Run once with a reviewed migration/owner role, not runtime.
-- No extensions, roles, credentials, grants to runtime, or external services are created.
BEGIN;

CREATE SCHEMA IF NOT EXISTS codia_cloud;
REVOKE ALL ON SCHEMA codia_cloud FROM PUBLIC;

CREATE TABLE codia_cloud.workspaces (
  tenant_id text NOT NULL CHECK (length(btrim(tenant_id)) BETWEEN 1 AND 128),
  owner_id text NOT NULL CHECK (length(btrim(owner_id)) BETWEEN 1 AND 128),
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (tenant_id, owner_id, workspace_id)
);

CREATE TABLE codia_cloud.files (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  workspace_id uuid NOT NULL,
  file_id uuid NOT NULL,
  logical_path text NOT NULL CHECK (
    length(logical_path) BETWEEN 1 AND 1024
    AND logical_path !~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|[[:cntrl:]])'
    AND position(E'\\' in logical_path) = 0
  ),
  current_version_id uuid,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_id, workspace_id, file_id),
  UNIQUE (tenant_id, owner_id, workspace_id, logical_path),
  FOREIGN KEY (tenant_id, owner_id, workspace_id)
    REFERENCES codia_cloud.workspaces (tenant_id, owner_id, workspace_id)
);

CREATE TABLE codia_cloud.file_versions (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  workspace_id uuid NOT NULL,
  file_id uuid NOT NULL,
  version_id uuid NOT NULL,
  version_number bigint NOT NULL CHECK (version_number >= 1),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL DEFAULT 'application/octet-stream',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_id, workspace_id, file_id, version_id),
  UNIQUE (tenant_id, owner_id, workspace_id, file_id, version_number),
  UNIQUE (tenant_id, owner_id, object_key),
  FOREIGN KEY (tenant_id, owner_id, workspace_id, file_id)
    REFERENCES codia_cloud.files (tenant_id, owner_id, workspace_id, file_id)
);

ALTER TABLE codia_cloud.files ADD CONSTRAINT files_current_version_fk
  FOREIGN KEY (tenant_id, owner_id, workspace_id, file_id, current_version_id)
  REFERENCES codia_cloud.file_versions (tenant_id, owner_id, workspace_id, file_id, version_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE codia_cloud.runs (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input) = 'object'),
  output jsonb,
  last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, owner_id, workspace_id, run_id),
  UNIQUE (tenant_id, owner_id, workspace_id, idempotency_key),
  FOREIGN KEY (tenant_id, owner_id, workspace_id)
    REFERENCES codia_cloud.workspaces (tenant_id, owner_id, workspace_id),
  CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE TABLE codia_cloud.run_events (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_id, workspace_id, run_id, sequence),
  FOREIGN KEY (tenant_id, owner_id, workspace_id, run_id)
    REFERENCES codia_cloud.runs (tenant_id, owner_id, workspace_id, run_id)
);

CREATE TABLE codia_cloud.outbox (
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  workspace_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event_sequence bigint NOT NULL,
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 100),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_id, workspace_id, outbox_id),
  UNIQUE (tenant_id, owner_id, workspace_id, run_id, event_sequence, topic),
  FOREIGN KEY (tenant_id, owner_id, workspace_id, run_id, event_sequence)
    REFERENCES codia_cloud.run_events (tenant_id, owner_id, workspace_id, run_id, sequence)
);

CREATE INDEX workspaces_owner_recent ON codia_cloud.workspaces (tenant_id, owner_id, updated_at DESC);
CREATE INDEX runs_workspace_recent ON codia_cloud.runs (tenant_id, owner_id, workspace_id, created_at DESC);
CREATE INDEX outbox_pending ON codia_cloud.outbox (tenant_id, owner_id, available_at)
  WHERE delivered_at IS NULL;

-- Owner-only MVP: membership/team sharing requires a separately reviewed policy.
-- With no transaction-local context, current_setting(..., true) is NULL/empty:
-- the predicate fails closed. Both USING and WITH CHECK protect every operation.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspaces', 'files', 'file_versions', 'runs', 'run_events', 'outbox']
  LOOP
    EXECUTE format('ALTER TABLE codia_cloud.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE codia_cloud.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY owner_tenant_isolation ON codia_cloud.%I FOR ALL '
      'USING (tenant_id = NULLIF(current_setting(''codia.tenant_id'', true), '''') '
      'AND owner_id = NULLIF(current_setting(''codia.actor_id'', true), '''')) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''codia.tenant_id'', true), '''') '
      'AND owner_id = NULLIF(current_setting(''codia.actor_id'', true), ''''))', table_name
    );
  END LOOP;
END;
$rls$;

-- Snapshots and event history are append-only even if excessive table grants
-- are accidentally added later. Operational retention needs a separate process.
CREATE FUNCTION codia_cloud.reject_history_mutation() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION 'Cloud workspace history is immutable' USING ERRCODE = '55000';
END;
$body$;
REVOKE ALL ON FUNCTION codia_cloud.reject_history_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_file_versions BEFORE UPDATE OR DELETE ON codia_cloud.file_versions
  FOR EACH ROW EXECUTE FUNCTION codia_cloud.reject_history_mutation();
CREATE TRIGGER immutable_run_events BEFORE UPDATE OR DELETE ON codia_cloud.run_events
  FOR EACH ROW EXECUTE FUNCTION codia_cloud.reject_history_mutation();
REVOKE ALL ON ALL TABLES IN SCHEMA codia_cloud FROM PUBLIC;

COMMIT;
