#!/usr/bin/env node
/** Real running Codia API smoke. Synthetic isolated data, no credentials logged. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const home = process.env.GSAP_SMOKE_HOME;
if (!home) throw new Error('Set GSAP_SMOKE_HOME to an isolated running Codia data directory');
const info = JSON.parse(fs.readFileSync(path.join(home, 'server-info.json'), 'utf8'));
const base = `http://127.0.0.1:${info.port}`;
const frontend = process.env.GSAP_SMOKE_FRONTEND || '';
let cookie = '';
async function request(route, { method = 'GET', body, origin, expected = 200, target = base } = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'cloud-studio' } : {}), ...(origin ? { Origin: origin } : {}) };
  const response = await fetch(`${target}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, expected, `${method} ${route}: expected ${expected}, got ${response.status}`); return response;
}
async function login() {
  const response = await request('/api/web-auth/login', { method: 'POST', body: { credential: info.token } }); cookie = response.headers.get('set-cookie').split(';')[0]; assert.ok(cookie);
  assert.equal((await (await request('/api/web-auth/session')).json()).authenticated, true);
}
const results = [];
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
try {
  await login(); pass('Existing Codia web-auth login issues a working session');
  if (process.argv.includes('--verify-persisted')) {
    const marker = JSON.parse(fs.readFileSync(path.join(home, 'cloud-smoke-marker.json'), 'utf8')); const detail = await (await request(`/api/cloud/runs/${marker.runId}`)).json(); assert.equal(detail.run.status, 'succeeded');
    const input = Buffer.from(await (await request(`/api/cloud/versions/${marker.inputVersion}/content`)).arrayBuffer()); const artifact = Buffer.from(await (await request(`/api/cloud/versions/${marker.artifactVersion}/content`)).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(input).digest('hex'), marker.inputSha256); assert.equal(crypto.createHash('sha256').update(artifact).digest('hex'), marker.artifactSha256);
    pass('Full application restart retains workspace, run, immutable input and artifact hashes'); console.log('2/2 restart verification checks passed.');
  } else {
    const health = await (await request('/api/cloud/health')).json(); assert.equal(health.productionReady, false); assert.equal(health.database, 'sqlite-local'); assert.equal(health.executor, 'codia-agent'); assert.equal(health.executorAvailable, false); pass('Runtime reports local persistence and unavailable unconfigured model honestly');
    const workspace = (await (await request('/api/cloud/workspaces', { method: 'POST', expected: 201, body: { name: `冒烟验证-${Date.now()}` } })).json()).workspace;
    const input = Buffer.from('# 云端工作空间验收\n\n任务读取固定版本并持久保存产物。\n这是一份合成测试文件。\n');
    const uploaded = await (await request(`/api/cloud/workspaces/${workspace.id}/files`, { method: 'POST', expected: 201, body: { name: 'smoke-notes.md', contentBase64: input.toString('base64') } })).json(); assert.equal(uploaded.file.size, input.length); assert.equal(uploaded.file.version_count, 1); pass('Workspace creation and immutable upload return complete metadata');
    assert.deepEqual(Buffer.from(await (await request(`/api/cloud/versions/${uploaded.version.id}/content`)).arrayBuffer()), input); pass('Authorized download preserves original bytes');
    const runBody = { inputVersion: uploaded.version.id, operation: 'document-summary', requestKey: crypto.randomUUID() };
    const run = (await (await request(`/api/cloud/workspaces/${workspace.id}/runs`, { method: 'POST', expected: 202, body: runBody })).json()).run;
    assert.equal((await (await request(`/api/cloud/workspaces/${workspace.id}/runs`, { method: 'POST', expected: 202, body: runBody })).json()).run.id, run.id); pass('Repeated submission resolves to one durable run');
    await request('/api/web-auth/logout', { method: 'POST', body: {} }); cookie = ''; await request(`/api/cloud/runs/${run.id}`, { expected: 403 }); await new Promise(resolve => setTimeout(resolve, 1000)); await login();
    let detail; for (let i = 0; i < 20; i++) { detail = await (await request(`/api/cloud/runs/${run.id}`)).json(); if (['succeeded', 'failed'].includes(detail.run.status)) break; await new Promise(resolve => setTimeout(resolve, 250)); }
    assert.equal(detail.run.status, 'succeeded'); assert.equal(detail.artifacts.length, 1); pass('Task continues after logout and is visible in a new authenticated session');
    const artifact = detail.artifacts[0]; const text = await (await request(`/api/cloud/versions/${artifact.version_id}/content`)).text(); assert.ok(text.includes('未调用大模型')); assert.ok(text.includes(uploaded.version.id)); pass('Artifact content pins input version and labels deterministic non-LLM processing');
    const v2 = await (await request(`/api/cloud/files/${uploaded.file.id}/versions`, { method: 'POST', expected: 201, body: { expectedVersion: uploaded.version.id, contentBase64: Buffer.from('# v2').toString('base64') } })).json(); assert.equal(v2.file.version_count, 2);
    await request(`/api/cloud/files/${uploaded.file.id}/versions`, { method: 'POST', expected: 409, body: { expectedVersion: uploaded.version.id, contentBase64: Buffer.from('stale').toString('base64') } }); pass('Version update succeeds; stale concurrent writer receives 409');
    const events = await (await request(`/api/cloud/workspaces/${workspace.id}/events?after=0`)).json(); assert.ok(events.events.some(e => e.kind === 'run.succeeded')); assert.equal((await (await request(`/api/cloud/workspaces/${workspace.id}/events?after=${events.cursor}`)).json()).events.length, 0); pass('Persistent event cursor catches up without duplicate results');
    if (frontend) { await request('/api/cloud/workspaces', { target: frontend, method: 'POST', origin: frontend, expected: 201, body: { name: '开发代理同源检查' } }); await request('/api/cloud/workspaces', { target: frontend, method: 'POST', origin: 'https://untrusted.invalid', expected: 403, body: { name: 'must not create' } }); pass('Existing dev-web proxy permits exact frontend origin and rejects foreign origin'); }
    const binaryBytes = Buffer.from([0,255,128,13,10,0,42]);
    const binary = await (await request(`/api/cloud/workspaces/${workspace.id}/files`, {method:'POST',expected:201,body:{name:'binary-smoke.bin',contentBase64:binaryBytes.toString('base64')}})).json();
    assert.deepEqual(Buffer.from(await (await request(`/api/cloud/versions/${binary.version.id}/content?download=1`)).arrayBuffer()),binaryBytes);pass('Binary file upload/download preserves exact bytes');
    const workflow = (await (await request(`/api/cloud/workspaces/${workspace.id}/records`, {method:'POST',expected:201,body:{kind:'workflow',title:'Cloud release draft',data:{instruction:'Verify synthetic release',steps:[]}}})).json()).record;
    const saved = (await (await request(`/api/cloud/records/${workflow.id}`,{method:'PUT',body:{expectedVersion:workflow.currentVersion,data:{instruction:'Verify and report',steps:['test']}}})).json()).record;
    await request(`/api/cloud/records/${workflow.id}`,{method:'PUT',expected:409,body:{expectedVersion:workflow.currentVersion,data:{instruction:'stale'}}});
    assert.equal((await (await request(`/api/cloud/records/${workflow.id}`)).json()).record.currentVersion,saved.currentVersion);pass('Cloud workflow CRUD persists canonical ID and rejects stale client edit');
    const conversation = (await (await request(`/api/cloud/workspaces/${workspace.id}/records`,{method:'POST',expected:201,body:{kind:'conversation',title:'Cloud conversation',data:{messages:[]}}})).json()).record;
    await request(`/api/cloud/records/${conversation.id}/messages`,{method:'POST',expected:503,body:{text:'Synthetic question',expectedVersion:conversation.currentVersion,requestKey:crypto.randomUUID()}});
    assert.equal((await (await request(`/api/cloud/records/${conversation.id}`)).json()).record.data.messages.length,0);pass('Missing model rejects paid conversation without fake reply or queued message');
    fs.writeFileSync(path.join(home, 'cloud-smoke-marker.json'), JSON.stringify({ workspaceId: workspace.id, inputVersion: uploaded.version.id, artifactVersion: artifact.version_id, runId: run.id, inputSha256: crypto.createHash('sha256').update(input).digest('hex'), artifactSha256: crypto.createHash('sha256').update(text).digest('hex') }, null, 2));
    console.log(`\n${results.length}/${results.length} API smoke checks passed. Browser UI smoke is separate.`);
  }
} finally { if (cookie) await request('/api/web-auth/logout', { method: 'POST', body: {} }).catch(() => {}); }
