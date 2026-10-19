#!/usr/bin/env node
/** Offline, disposable UI fixtures. This never records a reviewed run or enables experience. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactStore, loadBetterSqliteDatabase } from '../lib/memory/fact-store.ts';
import { openExperienceStore } from '../lib/experience-store.ts';

export const MARKER_NAME = '.codia-memory-review-test.json';
const PURPOSE = 'codia-memory-review-synthetic-fixtures-v1';
const CONFIRMATION = '--confirm-test-home-and-stopped';
const PREFIX = '[合成测试数据]';

function refuse(message) { throw new Error(message); }
function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function regular(file, directory = false, required = false) {
  const info = stat(file);
  if (!info) { if (required) refuse(`尚未初始化：${file}。请先用该 CODIA_DEV_HOME 启动一次应用，然后完全关闭。`); return null; }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1)) {
    refuse(`拒绝链接或异常文件类型：${file}`);
  }
  return info;
}
function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function checkHome(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) refuse('必须用 --home 显式传入专用测试目录的绝对路径。');
  const resolved = path.resolve(home);
  // Reject defaults before opening any application file, including descendants.
  const protectedRoots = [os.homedir(), path.join(os.homedir(), '.codia'), path.join(os.homedir(), '.codia-dev')];
  const isProtected = value => value === path.parse(value).root || value === protectedRoots[0]
    || protectedRoots.slice(1).some(root => inside(value, root))
    || value.split(path.sep).some(part => ['.codia', '.codia-dev'].includes(part));
  if (isProtected(resolved)) refuse('拒绝真实默认目录：请使用独立的 codia-memory-test-* 测试目录。');
  regular(resolved, true, true);
  const realHome = fs.realpathSync(resolved);
  if (isProtected(realHome)) refuse('拒绝指向真实默认目录的路径。');
  if (!/^codia-memory-test-[A-Za-z0-9_-]+$/.test(path.basename(realHome))) {
    refuse('专用测试目录名必须为 codia-memory-test-*，例如 codia-memory-test-review。');
  }
  for (const part of ['agents', path.join('agents', 'codia')]) regular(path.join(realHome, part), true, true);
  // Only inspect file metadata: agent config can contain credentials and is never read.
  regular(path.join(realHome, 'agents', 'codia', 'config.yaml'), false, true);
  return realHome;
}

function assertEmptyDatabase(file, kind) {
  if (!stat(file)) return;
  const info = regular(file);
  if (info.size > 64 * 1024 * 1024) refuse(`数据库不是小型全新测试库，拒绝读取：${file}`);
  const Database = loadBetterSqliteDatabase();
  // A readonly WAL connection can still create sidecar files. Inspect a private
  // temporary copy so refusing existing data leaves the original byte-for-byte intact.
  const inspectionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-memory-seed-inspect-'));
  let db;
  try {
    const copy = path.join(inspectionDir, 'inspection.db');
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
    db = new Database(copy, { readonly: true, fileMustExist: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const ftsTables = new Set(['facts_fts', 'facts_fts_data', 'facts_fts_idx', 'facts_fts_content', 'facts_fts_docsize', 'facts_fts_config']);
    for (const { name } of tables) {
      if (kind === 'facts' && ftsTables.has(name)) continue;
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const count = kind === 'experience' && name === 'experience_meta'
        ? db.prepare(`SELECT COUNT(*) AS count FROM ${quoted} WHERE value != 0 OR key NOT IN ('epoch','generation','revocation_generation')`).get().count
        : db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count;
      if (count !== 0) refuse(`已有记忆、经验或历史记录，拒绝写入或覆盖：${file}。请换一个全新的测试目录。`);
    }
  } finally { db?.close(); fs.rmSync(inspectionDir, { recursive: true, force: true }); }
}

function assertPristineTree(directory, databaseName, kind) {
  if (!regular(directory, true)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { assertPristineTree(file, '', kind); continue; }
    const info = regular(file);
    if (entry.name === databaseName) continue;
    // Do not read legacy experience, summaries, journals or any credential-like file.
    if (info.size !== 0) refuse(`已有数据或未关闭的数据库，拒绝覆盖：${file}。请关闭应用并使用全新的测试目录。`);
  }
  if (databaseName) assertEmptyDatabase(path.join(directory, databaseName), kind);
}

export function seedMemoryReview({ home, confirmed = false } = {}) {
  if (!confirmed) refuse(`需要 ${CONFIRMATION}：确认这是专用测试目录，并且应用已经完全关闭。`);
  const realHome = checkHome(home);
  const markerPath = path.join(realHome, MARKER_NAME);
  const existingMarker = regular(markerPath);
  if (existingMarker) {
    if (existingMarker.size > 8192) refuse('测试目录标记异常；请换新的测试目录，不要删除标记重试。');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker.purpose !== PURPOSE || marker.home !== realHome || marker.status !== 'complete') {
      refuse('测试目录标记不匹配或上次写入未完成；请换新的测试目录，不要删除标记重试。');
    }
    // A rerun must never restore a fact the tester has corrected or forgotten.
    return { status: 'already_seeded', home: realHome, factsAdded: 0, experiencesAdded: 0 };
  }
  const agentDir = path.join(realHome, 'agents', 'codia');
  const memoryDir = path.join(agentDir, 'memory');
  const legacyIndex = regular(path.join(agentDir, 'experience.md'));
  if (legacyIndex?.size) refuse('已有旧版经验索引，拒绝混入夹具；请换一个全新的测试目录。');
  assertPristineTree(memoryDir, 'facts.db', 'facts');
  assertPristineTree(path.join(agentDir, 'experience'), 'experiences.db', 'experience');
  const marker = { purpose: PURPOSE, home: realHome, status: 'in_progress', synthetic: true, createdAt: new Date().toISOString() };
  // Exclusive creation prevents two seed processes from racing. Failure stays fail-closed.
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' });
  let facts;
  let experience;
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    facts = new FactStore(path.join(memoryDir, 'facts.db'));
    experience = openExperienceStore(agentDir);
    const inputs = [
      { fact: `${PREFIX} 虚构角色小禾偏好简体中文和简短回答；这不是用户真实偏好。`, status: 'active', kind: 'preference' },
      { fact: `${PREFIX} 虚构演示项目的主题色暂定为蓝色，等待人工核对。`, status: 'conflict', projectId: 'synthetic-memory-review' },
      { fact: `${PREFIX} 在一次性演示环境中，先关闭应用再初始化夹具可避免并行写入；此示例尚未核实。`, status: 'candidate', projectId: 'synthetic-memory-review' },
    ];
    const ids = inputs.map((input, index) => facts.add({
      ...input, tags: ['synthetic-test-only', '合成测试数据'], reviewStatus: 'unverified',
      source: `${PREFIX} 本地夹具脚本，非聊天或真实运行`,
      sourceRefs: [{ kind: 'synthetic-test', id: `synthetic-memory-review-fact-${index + 1}`, author: '合成测试夹具' }],
      memoryId: `synthetic-memory-review-fact-${index + 1}`,
    }).id);
    const common = {
      category: '合成测试数据', taskType: 'synthetic-local-ui-review',
      preconditions: [`${PREFIX} 仅限一次性本地测试环境`],
      risks: [`${PREFIX} 不能将合成示例当作真实用户偏好、工作结果或执行授权`],
      rollback: `${PREFIX} 在界面撤回经验；重新测试请换全新独立目录`,
      applicability: { scope: 'project', projectId: 'synthetic-memory-review', platform: process.platform },
    };
    const candidates = [
      {
        ...common,
        content: `${PREFIX} 本地夹具脚本重复运行应保持事实与经验数量不变；这是待验证的测试假设。`,
        goal: `${PREFIX} 检查一次性测试环境中的幂等行为`,
        actions: [`${PREFIX} 关闭应用后再次运行种子脚本，重启界面检查数量与修改是否保留`],
        verificationMethod: `${PREFIX} 由人实际执行重复运行并查看界面，保存本次日志或截图后再记录核实结果`,
        // Deliberately no fabricated conversation/run provenance or reviewed evidence.
        sourceRefs: [],
      },
      {
        ...common,
        content: `${PREFIX} 此候选从第三条合成事实派生，用于测试来源被忘记后联动撤回。`,
        goal: `${PREFIX} 检查来源失效后的经验撤回`,
        actions: [`${PREFIX} 在界面忘记第三条合成事实，然后刷新经验列表`],
        verificationMethod: `${PREFIX} 人工观察该候选是否撤回；种子脚本不提供核实结果`,
        sourceRefs: [{ type: 'fact', id: String(ids[2]), revision: 1, author: '合成测试夹具' }],
        parentMemoryIds: ['synthetic-memory-review-fact-3'],
      },
    ];
    candidates.forEach((candidate, index) => experience.createCandidate(candidate, { eventId: `synthetic-memory-review-seed-${index + 1}` }));
    experience.close(); experience = null;
    facts.close(); facts = null;
    fs.writeFileSync(markerPath, JSON.stringify({ ...marker, status: 'complete', factsCreated: 3, candidatesCreated: 2 }, null, 2) + '\n');
    return { status: 'seeded', home: realHome, factsAdded: 3, experiencesAdded: 2, verifiedEvidenceCreated: 0 };
  } finally {
    experience?.close();
    facts?.close();
  }
}

function main(args) {
  let home;
  let confirmed = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') {
      process.stdout.write(`用法：node scripts/seed-memory-review.mjs --home /绝对路径/codia-memory-test-review ${CONFIRMATION}\n先用此 CODIA_DEV_HOME 启动一次应用并完全关闭。仅创建合成事实与候选经验，不联网、不读取凭据、不生成核实证据。\n`);
      return;
    }
    if (arg === '--home' && !home && args[index + 1] && !args[index + 1].startsWith('--')) home = args[++index];
    else if (arg === CONFIRMATION && !confirmed) confirmed = true;
    else refuse(`未知、重复或缺值参数：${arg}`);
  }
  const result = seedMemoryReview({ home, confirmed });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(result.status === 'already_seeded'
    ? '本目录已经准备过：未新增、覆盖或恢复任何数据。\n'
    : '已准备 3 条合成事实和 2 条候选经验。所有运行证据与核实计数均为空；请重启此测试目录的应用。\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`拒绝或准备失败：${error.message}\n`); process.exitCode = 1; }
}
