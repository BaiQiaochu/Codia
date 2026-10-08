-- Durable bounded resumable uploads and explicit run retries. Requires runtime v4.
-- Apply with the existing reviewed migration identity. No roles or credentials are
-- provisioned here. Runtime API/worker roles must remain NOSUPERUSER NOBYPASSRLS;
-- grant SELECT,INSERT,UPDATE on uploads/upload_chunks and existing tables as needed.
-- The runtime database login is internal-only; clients never receive SQL access.
-- Owner transactions clear trusted_worker; FORCE RLS matches runtime v2/v4 scope.
BEGIN;
DO $check$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM codia_workspace.schema_version WHERE version=4) THEN
  RAISE EXCEPTION 'Apply workspace migration 004 first';
 END IF;
END $check$;
ALTER TABLE codia_workspace.runs ADD COLUMN retry_of uuid;
ALTER TABLE codia_workspace.runs ADD CONSTRAINT retry_run_owner_fk
 FOREIGN KEY(retry_of,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.runs(id,workspace_id,owner_user,studio_id);
ALTER TABLE codia_workspace.runs ADD CONSTRAINT retry_not_self CHECK(retry_of IS NULL OR retry_of<>id);

CREATE TABLE codia_workspace.uploads (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160), size integer NOT NULL CHECK(size BETWEEN 0 AND 33554432),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{8,128}$'),
 creation_spec jsonb NOT NULL CHECK(jsonb_typeof(creation_spec)='object'), file_id uuid NOT NULL, expected_version uuid,
 version_id uuid NOT NULL UNIQUE, state text NOT NULL CHECK(state IN ('uploading','completing','completed','cancelled','expired')),
 expires_at bigint NOT NULL CHECK(expires_at BETWEEN 0 AND 253402300799999), revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 manifest_sha256 text CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key), UNIQUE(id,workspace_id,owner_user,studio_id),
 CHECK(state NOT IN ('completing','completed') OR manifest_sha256 IS NOT NULL),
 FOREIGN KEY(workspace_id,owner_user,studio_id) REFERENCES codia_workspace.workspaces(id,owner_user,studio_id),
 FOREIGN KEY(file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.files(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(expected_version,file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(version_id,file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id)
);
CREATE INDEX uploads_owner_active ON codia_workspace.uploads(owner_user,studio_id,state,expires_at);
CREATE INDEX uploads_workspace ON codia_workspace.uploads(workspace_id,created_at,id);
CREATE TABLE codia_workspace.upload_chunks (
 upload_id uuid NOT NULL, workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 31), size integer NOT NULL CHECK(size BETWEEN 1 AND 1048576),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), PRIMARY KEY(upload_id,chunk_index),
 FOREIGN KEY(upload_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.uploads(id,workspace_id,owner_user,studio_id)
);
DO $rls$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['uploads','upload_chunks'] LOOP
  EXECUTE format('ALTER TABLE codia_workspace.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE codia_workspace.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY owner_scope ON codia_workspace.%I FOR ALL '
   'USING ((owner_user=NULLIF(current_setting(''codia.actor_id'',true),'''') AND studio_id=NULLIF(current_setting(''codia.tenant_id'',true),'''')) OR current_setting(''codia.trusted_worker'',true)=''on'') '
   'WITH CHECK ((owner_user=NULLIF(current_setting(''codia.actor_id'',true),'''') AND studio_id=NULLIF(current_setting(''codia.tenant_id'',true),'''')) OR current_setting(''codia.trusted_worker'',true)=''on'')',table_name);
 END LOOP;
END $rls$;
CREATE FUNCTION codia_workspace.protect_upload() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Upload metadata is retained'; END IF;
 IF (to_jsonb(OLD)-ARRAY['state','revision','manifest_sha256','updated_at']) <>
    (to_jsonb(NEW)-ARRAY['state','revision','manifest_sha256','updated_at']) OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Upload specification is immutable';
 END IF;
 IF OLD.state NOT IN ('uploading','completing') OR
    (OLD.state='completing' AND NEW.state='uploading') OR (OLD.state='uploading' AND NEW.state='completed') THEN
  RAISE EXCEPTION 'Invalid upload state transition';
 END IF;
 IF (OLD.manifest_sha256 IS NOT NULL AND NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256) OR
    (OLD.manifest_sha256 IS NULL AND NEW.manifest_sha256 IS NOT NULL AND NEW.state<>'completing') THEN
  RAISE EXCEPTION 'Upload manifest is immutable';
 END IF;
 IF NEW.state IN ('completing','completed') AND (SELECT count(*) FROM codia_workspace.upload_chunks WHERE upload_id=NEW.id)<>ceil(NEW.size/1048576.0) THEN
  RAISE EXCEPTION 'Upload manifest is incomplete';
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER immutable_upload BEFORE UPDATE OR DELETE ON codia_workspace.uploads FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_upload();
CREATE FUNCTION codia_workspace.protect_upload_chunk() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
DECLARE upload_row codia_workspace.uploads;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Upload chunks are immutable'; END IF;
 SELECT * INTO upload_row FROM codia_workspace.uploads WHERE id=NEW.upload_id FOR UPDATE;
 IF upload_row.id IS NULL OR upload_row.state<>'uploading' OR upload_row.expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint OR
    NEW.chunk_index*1048576>=upload_row.size OR NEW.size<>least(1048576,upload_row.size-NEW.chunk_index*1048576) THEN
  RAISE EXCEPTION 'Invalid upload chunk';
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER immutable_upload_chunk BEFORE INSERT OR UPDATE OR DELETE ON codia_workspace.upload_chunks FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_upload_chunk();
CREATE FUNCTION codia_workspace.protect_retry_link() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
 IF TG_OP='UPDATE' AND OLD.retry_of IS NOT NULL AND NEW.retry_of IS DISTINCT FROM OLD.retry_of THEN RAISE EXCEPTION 'Retry source is immutable'; END IF;
 IF NEW.retry_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM codia_workspace.runs source WHERE source.id=NEW.retry_of
   AND source.workspace_id=NEW.workspace_id AND source.owner_user=NEW.owner_user AND source.studio_id=NEW.studio_id
   AND source.status='failed' AND source.operation<>'agent-conversation' AND source.operation=NEW.operation AND source.input_version=NEW.input_version) THEN
  RAISE EXCEPTION 'Invalid retry source';
 END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER immutable_retry_link BEFORE INSERT OR UPDATE ON codia_workspace.runs FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_retry_link();
REVOKE ALL ON codia_workspace.uploads,codia_workspace.upload_chunks FROM PUBLIC;
REVOKE ALL ON FUNCTION codia_workspace.protect_upload(),codia_workspace.protect_upload_chunk(),codia_workspace.protect_retry_link() FROM PUBLIC;
INSERT INTO codia_workspace.schema_version VALUES(5);
COMMIT;
