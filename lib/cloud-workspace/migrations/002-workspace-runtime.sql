-- Runtime schema v2. Apply explicitly with a reviewed migration/owner identity.
-- Independent of the unreleased 001 design schema; no data is copied implicitly.
-- No roles, credentials, grants or hosted resources are provisioned by this file.
BEGIN;
CREATE SCHEMA codia_workspace;
REVOKE ALL ON SCHEMA codia_workspace FROM PUBLIC;
CREATE TABLE codia_workspace.schema_version (version integer PRIMARY KEY);
INSERT INTO codia_workspace.schema_version VALUES (2);
CREATE TABLE codia_workspace.workspaces (
 id uuid PRIMARY KEY, owner_user text NOT NULL CHECK(length(owner_user) BETWEEN 1 AND 128),
 studio_id text NOT NULL CHECK(length(studio_id) BETWEEN 1 AND 128), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id, owner_user, studio_id)
);
CREATE TABLE codia_workspace.files (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 name text NOT NULL, current_version uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,name), UNIQUE(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(workspace_id,owner_user,studio_id) REFERENCES codia_workspace.workspaces(id,owner_user,studio_id)
);
CREATE TABLE codia_workspace.versions (
 id uuid PRIMARY KEY, file_id uuid NOT NULL, workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 object_key text NOT NULL UNIQUE CHECK(length(object_key) BETWEEN 1 AND 1024),
 size integer NOT NULL CHECK(size >= 0), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('staging','ready','rejected')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,file_id,workspace_id,owner_user,studio_id), UNIQUE(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.files(id,workspace_id,owner_user,studio_id)
);
ALTER TABLE codia_workspace.files ADD CONSTRAINT current_version_owner_fk
 FOREIGN KEY(current_version,id,workspace_id,owner_user,studio_id)
 REFERENCES codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE codia_workspace.runs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 input_version uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('document-summary','agent-summary','agent-conversation')),
 request_key text NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3), lease_until bigint,
 artifact_file_id uuid, error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key), UNIQUE(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(workspace_id,owner_user,studio_id) REFERENCES codia_workspace.workspaces(id,owner_user,studio_id),
 FOREIGN KEY(input_version,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(artifact_file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.files(id,workspace_id,owner_user,studio_id),
 CHECK((status = 'running') = (lease_until IS NOT NULL))
);
CREATE TABLE codia_workspace.artifacts (
 id uuid PRIMARY KEY, run_id uuid NOT NULL UNIQUE, file_id uuid NOT NULL, version_id uuid NOT NULL,
 workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 FOREIGN KEY(run_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.runs(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(version_id,file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id)
);
CREATE TABLE codia_workspace.outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 run_id uuid, kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published boolean NOT NULL DEFAULT false,
 FOREIGN KEY(workspace_id,owner_user,studio_id) REFERENCES codia_workspace.workspaces(id,owner_user,studio_id),
 FOREIGN KEY(run_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.runs(id,workspace_id,owner_user,studio_id)
);
CREATE TABLE codia_workspace.events (
 id bigint PRIMARY KEY REFERENCES codia_workspace.outbox(id), workspace_id uuid NOT NULL,
 owner_user text NOT NULL, studio_id text NOT NULL, run_id uuid, kind text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL,
 FOREIGN KEY(workspace_id,owner_user,studio_id) REFERENCES codia_workspace.workspaces(id,owner_user,studio_id),
 FOREIGN KEY(run_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.runs(id,workspace_id,owner_user,studio_id)
);
CREATE INDEX workspace_owner ON codia_workspace.workspaces(owner_user,studio_id,created_at,id);
CREATE INDEX run_claim ON codia_workspace.runs(status,lease_until,created_at,id);
CREATE INDEX workspace_events ON codia_workspace.events(workspace_id,id);
CREATE INDEX pending_outbox ON codia_workspace.outbox(id) WHERE NOT published;
CREATE INDEX staging_versions ON codia_workspace.versions(created_at) WHERE status='staging';
-- The database is an internal application authority, never a browser-facing API.
-- Owner transactions set trusted_worker=off explicitly. Only internal maintenance
-- transactions set it on. A runtime database login must not be exposed to users.
-- Deployment may use a separate worker pool with the same schema grants.
DO $rls$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['workspaces','files','versions','runs','artifacts','outbox','events'] LOOP
  EXECUTE format('ALTER TABLE codia_workspace.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE codia_workspace.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY owner_scope ON codia_workspace.%I FOR ALL '
   'USING ((owner_user=NULLIF(current_setting(''codia.actor_id'',true),'''') AND studio_id=NULLIF(current_setting(''codia.tenant_id'',true),'''')) OR current_setting(''codia.trusted_worker'',true)=''on'') '
   'WITH CHECK ((owner_user=NULLIF(current_setting(''codia.actor_id'',true),'''') AND studio_id=NULLIF(current_setting(''codia.tenant_id'',true),'''')) OR current_setting(''codia.trusted_worker'',true)=''on'')', table_name);
 END LOOP;
END;
$rls$;
CREATE FUNCTION codia_workspace.protect_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workspace versions cannot be deleted'; END IF;
 IF OLD.status <> 'staging' OR NEW.status NOT IN ('ready','rejected') OR (to_jsonb(OLD)-'status') <> (to_jsonb(NEW)-'status') THEN
  RAISE EXCEPTION 'Workspace version bytes and metadata are immutable';
 END IF;
 RETURN NEW;
END;
$body$;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON codia_workspace.versions FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_version();
CREATE FUNCTION codia_workspace.protect_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'Workspace events are immutable'; END;
$body$;
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON codia_workspace.events FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_event();
REVOKE ALL ON ALL TABLES IN SCHEMA codia_workspace FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA codia_workspace FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA codia_workspace FROM PUBLIC;
COMMIT;
