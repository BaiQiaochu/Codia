import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe } from 'vitest';
import { CloudWorkspaceStore } from '../lib/cloud-workspace/store.ts';
import { CloudWorkspaceService } from '../lib/cloud-workspace/service.ts';
import { LocalObjectStore } from '../lib/cloud-workspace/object-store.ts';
import { artifactCollisionContract } from './helpers/cloud-artifact-contract.ts';
let directory: string, store: CloudWorkspaceStore, service: CloudWorkspaceService;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-artifact-collision-'));
  store = new CloudWorkspaceStore(path.join(directory, 'metadata.db'));
  service = new CloudWorkspaceService(store, new LocalObjectStore(path.join(directory, 'objects')));
});
afterEach(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
describe('SQLite result filename collision recovery', () => { artifactCollisionContract(() => ({ service })); });
