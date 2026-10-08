import path from 'node:path';
import { Pool } from 'pg';
import { CloudWorkspaceStore } from './store.ts';
import { asAsyncWorkspaceRepository, type CloudWorkspaceRepository } from './repository.ts';
import { PostgresWorkspaceStore } from './postgres-store.ts';
import { LocalObjectStore, S3ObjectStore, type ObjectStore, type S3ObjectStoreOptions } from './object-store.ts';

export class CloudWorkspaceConfigError extends Error {
  readonly code = 'cloud_workspace_configuration_error';
  constructor(message: string) { super(message); this.name = 'CloudWorkspaceConfigError'; }
}
export type CloudWorkspaceConfig = {
  database: 'sqlite' | 'postgres'; objectStore: 'local' | 's3'; localDirectory: string;
  postgres?: { connectionString: string; max: number; ssl?: { rejectUnauthorized: true; ca?: string } };
  s3?: S3ObjectStoreOptions;
};
function required(env: NodeJS.ProcessEnv, name: string) { const value = env[name]?.trim(); if (!value) throw new CloudWorkspaceConfigError(`${name} is required`); return value; }
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number) { const value = env[name] === undefined ? fallback : Number(env[name]); if (!Number.isInteger(value) || value < 1 || value > max) throw new CloudWorkspaceConfigError(`${name} must be an integer between 1 and ${max}`); return value; }

/** No fallback: production is explicitly PostgreSQL + S3, with complete settings. */
export function readCloudWorkspaceConfig(options: {localDirectory: string; env?: NodeJS.ProcessEnv}): CloudWorkspaceConfig {
  const env = options.env ?? process.env;
  if (env.CODIA_CLOUD_MODE && !['local','production'].includes(env.CODIA_CLOUD_MODE)) throw new CloudWorkspaceConfigError('CODIA_CLOUD_MODE must be local or production');
  // NODE_ENV is also production in packaged offline desktop builds. Hosted-cloud
  // guarantees use their own explicit deployment switch, not the bundler mode.
  const production = env.CODIA_CLOUD_MODE === 'production';
  const database = env.CODIA_CLOUD_DATABASE?.trim() || (production ? '' : 'sqlite');
  const objectStore = env.CODIA_CLOUD_OBJECT_STORE?.trim() || (production ? '' : 'local');
  if (!['sqlite','postgres'].includes(database)) throw new CloudWorkspaceConfigError('CODIA_CLOUD_DATABASE must explicitly select sqlite or postgres');
  if (!['local','s3'].includes(objectStore)) throw new CloudWorkspaceConfigError('CODIA_CLOUD_OBJECT_STORE must explicitly select local or s3');
  if (production && (database !== 'postgres' || objectStore !== 's3')) throw new CloudWorkspaceConfigError('Production cloud workspaces require PostgreSQL and S3; local fallback is disabled');
  if ((database === 'postgres') !== (objectStore === 's3')) throw new CloudWorkspaceConfigError('Use sqlite + local or postgres + s3 together; mixed persistence is unsupported');
  if (!options.localDirectory) throw new CloudWorkspaceConfigError('A local workspace directory is required');
  const config: CloudWorkspaceConfig = { database: database as CloudWorkspaceConfig['database'], objectStore: objectStore as CloudWorkspaceConfig['objectStore'], localDirectory: path.resolve(options.localDirectory) };
  if (database === 'postgres') {
    const connectionString = required(env, 'CODIA_CLOUD_DATABASE_URL');
    let url: URL;
    try { url = new URL(connectionString); } catch { throw new CloudWorkspaceConfigError('CODIA_CLOUD_DATABASE_URL must be a PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') throw new CloudWorkspaceConfigError('CODIA_CLOUD_DATABASE_URL must identify a PostgreSQL host and database');
    // URL SSL flags can override the driver ssl object. Keep one validated source.
    if (url.search) throw new CloudWorkspaceConfigError('Set CODIA_CLOUD_DATABASE_TLS and optional CODIA_CLOUD_DATABASE_CA instead of URL parameters; driver query overrides are unsupported');
    const tls = env.CODIA_CLOUD_DATABASE_TLS ?? (production ? 'verify-full' : 'disable');
    if (!['verify-full','disable'].includes(tls)) throw new CloudWorkspaceConfigError('CODIA_CLOUD_DATABASE_TLS must be verify-full or disable');
    if (tls === 'disable' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new CloudWorkspaceConfigError('Unencrypted PostgreSQL is restricted to explicit loopback development');
    if (production && tls !== 'verify-full') throw new CloudWorkspaceConfigError('Production PostgreSQL requires verified TLS');
    config.postgres = { connectionString, max: integer(env, 'CODIA_CLOUD_DATABASE_POOL_SIZE', 10, 50), ...(tls === 'verify-full' ? {ssl: {rejectUnauthorized: true as const, ...(env.CODIA_CLOUD_DATABASE_CA ? {ca: env.CODIA_CLOUD_DATABASE_CA} : {})}} : {}) };
    config.s3 = {
      endpoint: required(env, 'CODIA_CLOUD_S3_ENDPOINT'), bucket: required(env, 'CODIA_CLOUD_S3_BUCKET'), region: required(env, 'CODIA_CLOUD_S3_REGION'),
      accessKeyId: required(env, 'CODIA_CLOUD_S3_ACCESS_KEY_ID'), secretAccessKey: required(env, 'CODIA_CLOUD_S3_SECRET_ACCESS_KEY'),
      ...(env.CODIA_CLOUD_S3_SESSION_TOKEN ? {sessionToken: env.CODIA_CLOUD_S3_SESSION_TOKEN} : {}), timeoutMs: integer(env, 'CODIA_CLOUD_S3_TIMEOUT_MS', 15_000, 15_000),
    };
    // Constructor is validation only; no network or credentials are transmitted.
    new S3ObjectStore(config.s3);
  } else if (['CODIA_CLOUD_DATABASE_URL','CODIA_CLOUD_S3_ENDPOINT','CODIA_CLOUD_S3_BUCKET'].some(name => env[name])) {
    throw new CloudWorkspaceConfigError('Cloud connection settings require explicit postgres + s3 selectors');
  }
  return config;
}
export type CloudWorkspaceRuntime = { store: CloudWorkspaceRepository; objects: ObjectStore; close(): Promise<void> };
export async function createCloudWorkspaceRuntime(options: {localDirectory: string; env?: NodeJS.ProcessEnv}): Promise<CloudWorkspaceRuntime> {
  const config = readCloudWorkspaceConfig(options);
  if (config.database === 'sqlite') {
    const store = asAsyncWorkspaceRepository(new CloudWorkspaceStore(path.join(config.localDirectory, 'metadata.db')));
    return { store, objects: new LocalObjectStore(path.join(config.localDirectory, 'objects')), close: () => store.close() };
  }
  const objects = new S3ObjectStore(config.s3!);
  const pool = new Pool({ ...config.postgres!, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, application_name: 'codia-cloud-workspace', options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000' });
  // Pool errors otherwise become unhandled EventEmitter exceptions. Connection
  // operations still reject; avoid logging server strings or credential URLs.
  pool.on('error', () => {});
  const store = new PostgresWorkspaceStore(pool, { closePool: () => pool.end() });
  try { await store.verifySchema(); } catch { await pool.end(); throw new CloudWorkspaceConfigError('PostgreSQL workspace startup failed; verify connectivity, permissions and migration 002-workspace-runtime.sql'); }
  return { store, objects, close: () => store.close() };
}
