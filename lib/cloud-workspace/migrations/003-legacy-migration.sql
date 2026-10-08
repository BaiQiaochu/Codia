-- Explicit, operator-reviewed legacy snapshot import metadata. Requires 002.
-- No source paths, secret values, role grants, or hosted resources are provisioned.
BEGIN;
CREATE TABLE codia_workspace.legacy_batches (
 id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL, workspace_id uuid NOT NULL,
 source_id text NOT NULL, plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('applied','rolled_back')), created_at timestamptz NOT NULL,
 PRIMARY KEY(owner_user,studio_id,workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user,studio_id) REFERENCES codia_workspace.workspaces(id,owner_user,studio_id)
);
CREATE TABLE codia_workspace.legacy_sources (
 owner_user text NOT NULL, studio_id text NOT NULL, workspace_id uuid NOT NULL, source_id text NOT NULL,
 source_key text NOT NULL, file_id uuid NOT NULL, imported_version_id uuid, sha256 text,
 PRIMARY KEY(owner_user,studio_id,workspace_id,source_id,source_key),
 FOREIGN KEY(file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.files(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(imported_version_id,file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id)
);
CREATE TABLE codia_workspace.legacy_items (
 owner_user text NOT NULL, studio_id text NOT NULL, workspace_id uuid NOT NULL, batch_id uuid NOT NULL,
 source_id text NOT NULL, source_key text NOT NULL, file_id uuid NOT NULL, version_id uuid NOT NULL,
 previous_version_id uuid, previous_imported_version_id uuid, previous_sha256 text, sha256 text NOT NULL,
 PRIMARY KEY(owner_user,studio_id,workspace_id,batch_id,source_key),
 FOREIGN KEY(owner_user,studio_id,workspace_id,batch_id) REFERENCES codia_workspace.legacy_batches(owner_user,studio_id,workspace_id,id),
 FOREIGN KEY(version_id,file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(previous_version_id,file_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,file_id,workspace_id,owner_user,studio_id)
);
CREATE TABLE codia_workspace.legacy_audit (
 owner_user text NOT NULL, studio_id text NOT NULL, workspace_id uuid NOT NULL, batch_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('applied','rolled_back')), payload jsonb NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(owner_user,studio_id,workspace_id,batch_id,action),
 FOREIGN KEY(owner_user,studio_id,workspace_id,batch_id) REFERENCES codia_workspace.legacy_batches(owner_user,studio_id,workspace_id,id)
);
DO $rls$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['legacy_batches','legacy_sources','legacy_items','legacy_audit'] LOOP
  EXECUTE format('ALTER TABLE codia_workspace.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE codia_workspace.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY migration_owner_scope ON codia_workspace.%I FOR ALL '
   'USING (owner_user=NULLIF(current_setting(''codia.actor_id'',true),'''') AND studio_id=NULLIF(current_setting(''codia.tenant_id'',true),'''')) '
   'WITH CHECK (owner_user=NULLIF(current_setting(''codia.actor_id'',true),'''') AND studio_id=NULLIF(current_setting(''codia.tenant_id'',true),''''))',table_name);
 END LOOP;
END;
$rls$;
CREATE TRIGGER immutable_legacy_items BEFORE UPDATE OR DELETE ON codia_workspace.legacy_items FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_event();
CREATE TRIGGER immutable_legacy_audit BEFORE UPDATE OR DELETE ON codia_workspace.legacy_audit FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_event();
REVOKE ALL ON codia_workspace.legacy_batches,codia_workspace.legacy_sources,codia_workspace.legacy_items,codia_workspace.legacy_audit FROM PUBLIC;
COMMIT;
