import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { CloudTaskService } from '../../lib/cloud-workspace/agent-tasks.ts';
import type { CloudWorkspaceService } from '../../lib/cloud-workspace/service.ts';
import { CloudWorkspaceWorker } from '../../lib/cloud-workspace/worker.ts';

const actor = { userId: 'artifact-owner', studioId: 'artifact-studio' };
export function artifactCollisionContract(context: () => { service: CloudWorkspaceService }) {
  it.each(['document-summary', 'agent-task'] as const)('completes a queued %s despite a later user upload with its result name', async operation => {
    const { service } = context();
    const workspace = await service.store.createWorkspace(actor, 'Artifact collision');
    const inputVersion = operation === 'agent-task'
      ? (await new CloudTaskService(service).create(actor, workspace.id, { title: 'Synthetic task', instruction: 'Return a result', requestKey: randomUUID() })).currentVersion
      : (await service.upload(actor, workspace.id, 'input.md', Buffer.from('# Synthetic input'))).version.id;
    const run = await service.store.createRun(actor, workspace.id, inputVersion, randomUUID(), operation);
    const names = operation === 'agent-task' ? [`task-session-${run.id}.json`]
      : [`检查结果-${run.id.slice(0, 8)}.md`, `检查结果-${run.id}.md`];
    // These are legitimate uploads through the public service while the task
    // is queued. Neither their names nor their existing versions may be changed.
    const uploads = await Promise.all(names.map(name => service.upload(actor, workspace.id, name, Buffer.from(`Keep original ${name}`))));
    let executions = 0;
    service.agentExecutor = {
      availability: async () => ({ available: true }),
      execute: async claimed => { executions++; return Buffer.from(JSON.stringify({ schemaVersion: 1, runId: claimed.id, attempt: claimed.attempt,
        inputVersion: claimed.input_version, finalText: 'Synthetic task result', inputVersions: [], messages: [], artifacts: [] })); },
    };
    const worker = new CloudWorkspaceWorker(service);
    await worker.tick(); await worker.stop();
    const detail = await service.store.run(actor, run.id);
    expect(detail.run, 'an existing user filename must not fail successful execution').toMatchObject({ status: 'succeeded', error: null });
    expect(detail.artifacts).toHaveLength(1);
    expect(names).not.toContain(detail.artifacts[0].name);
    expect((await service.read(actor, detail.artifacts[0].version_id)).bytes.toString()).toContain(operation === 'agent-task' ? 'Synthetic task result' : '固定文本处理流程');
    for (const [index, uploaded] of uploads.entries()) {
      expect((await service.store.file(actor, uploaded.file.id)).current_version).toBe(uploaded.version.id);
      expect((await service.read(actor, uploaded.version.id)).bytes.toString()).toBe(`Keep original ${names[index]}`);
      expect(await service.store.versions(actor, uploaded.file.id)).toHaveLength(1);
    }
    expect(detail.events.filter(event => event.kind === 'run.succeeded')).toHaveLength(1);
    expect(await worker.tick()).toBe(false);
    expect(executions).toBe(operation === 'agent-task' ? 1 : 0);
    expect((await service.store.run(actor, run.id)).artifacts).toEqual(detail.artifacts);
  });
}
