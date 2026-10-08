-- Durable task schedules and capability-scoped agent-task runs. Requires 002; 003 is optional.
-- Apply explicitly with the existing reviewed migration identity. No deployment
-- credentials, roles, security grants, or hosted resources are provisioned here.
BEGIN;
ALTER TABLE codia_workspace.runs DROP CONSTRAINT runs_operation_check;
ALTER TABLE codia_workspace.runs ADD CONSTRAINT runs_operation_check
 CHECK(operation IN ('document-summary','agent-summary','agent-conversation','agent-task'));

CREATE TABLE codia_workspace.schedules (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_user text NOT NULL, studio_id text NOT NULL,
 input_version uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('document-summary','agent-summary','agent-task')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160), request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{8,128}$'),
 state text NOT NULL CHECK(state IN ('enabled','paused','completed')),
 next_run_at bigint NOT NULL CHECK(next_run_at BETWEEN 0 AND 253402300799999),
 interval_ms bigint CHECK(interval_ms BETWEEN 60000 AND 31622400000),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991), last_run_id uuid,
 -- Original normalized intent is retained for idempotent create retries even
 -- after next_run_at, state, revision, or last_run_id has changed.
 creation_spec jsonb NOT NULL CHECK(jsonb_typeof(creation_spec)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key),
 FOREIGN KEY(workspace_id,owner_user,studio_id) REFERENCES codia_workspace.workspaces(id,owner_user,studio_id),
 FOREIGN KEY(input_version,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.versions(id,workspace_id,owner_user,studio_id),
 FOREIGN KEY(last_run_id,workspace_id,owner_user,studio_id) REFERENCES codia_workspace.runs(id,workspace_id,owner_user,studio_id)
);
CREATE INDEX schedule_due ON codia_workspace.schedules(next_run_at,id) WHERE state='enabled';
CREATE INDEX workspace_schedules ON codia_workspace.schedules(workspace_id,created_at,id);
ALTER TABLE codia_workspace.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE codia_workspace.schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON codia_workspace.schedules FOR ALL
 USING ((owner_user=NULLIF(current_setting('codia.actor_id',true),'') AND studio_id=NULLIF(current_setting('codia.tenant_id',true),'')) OR current_setting('codia.trusted_worker',true)='on')
 WITH CHECK ((owner_user=NULLIF(current_setting('codia.actor_id',true),'') AND studio_id=NULLIF(current_setting('codia.tenant_id',true),'')) OR current_setting('codia.trusted_worker',true)='on');

CREATE FUNCTION codia_workspace.protect_schedule() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
 IF (to_jsonb(OLD)-ARRAY['state','next_run_at','revision','last_run_id','updated_at']) <>
    (to_jsonb(NEW)-ARRAY['state','next_run_at','revision','last_run_id','updated_at']) THEN
  RAISE EXCEPTION 'Schedule specification is immutable';
 END IF;
 IF NEW.revision <> OLD.revision+1 THEN RAISE EXCEPTION 'Schedule revision must advance once'; END IF;
 IF OLD.state='completed' AND NEW.state<>'completed' THEN RAISE EXCEPTION 'Completed schedules cannot restart'; END IF;
 RETURN NEW;
END;
$body$;
CREATE TRIGGER immutable_schedule_spec BEFORE UPDATE ON codia_workspace.schedules FOR EACH ROW EXECUTE FUNCTION codia_workspace.protect_schedule();
REVOKE ALL ON codia_workspace.schedules FROM PUBLIC;
REVOKE ALL ON FUNCTION codia_workspace.protect_schedule() FROM PUBLIC;
INSERT INTO codia_workspace.schema_version VALUES (4);
COMMIT;
