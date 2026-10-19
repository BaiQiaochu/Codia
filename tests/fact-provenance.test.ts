import { describe, it, expect } from 'vitest';
import { createMemorySearchTool } from '../lib/memory/memory-search.ts';
import { FactStore } from '../lib/memory/fact-store.ts';

describe('fact evidence provenance', () => {
  it('retains explicit source and supplies session evidence on ordinary insert', () => {
    const store = new FactStore(':memory:');
    try {
      const a = store.add({ fact: 'Project research evidence', session_id: 's1' });
      const b = store.add({ fact: 'Document research evidence', source: 'document:report-v2' });
      expect(store.getById(a.id).source).toBe('session:s1');
      expect(store.getById(b.id).source).toBe('document:report-v2');
      expect(store.searchFullText('research').every(f => f.source)).toBe(true);
      store.delete(a.id);
      expect(store.searchFullText('research').some(f => f.id === a.id)).toBe(false);
    } finally { store.close(); }
  });
  it('preserves provenance through export/import', () => {
    const store = new FactStore(':memory:');
    const copy = new FactStore(':memory:');
    try {
      store.add({ fact: 'Evidence', source: 'document:v1' });
      copy.importAll(store.exportAll());
      expect(copy.getAll()[0].source).toBe('document:v1');
    } finally { store.close(); copy.close(); }
  });
});

describe('fact correction lifecycle', () => {
  it('corrects text without losing provenance, rejects stale writes and removes old search text', () => {
    const store = new FactStore(':memory:');
    try {
      const { id } = store.add({ fact: 'Old jasmine preference', tags: ['preference'], session_id: 'original' });
      const original = store.getById(id);
      const result = store.update(id, { fact: 'New coffee preference' }, original.updated_at);
      expect(result.memory.source).toBe('session:original');
      expect(result.memory.created_at).toBe(original.created_at);
      expect(result.memory.updated_at > original.updated_at).toBe(true);
      expect(store.searchFullText('jasmine')).toEqual([]);
      expect(store.searchFullText('coffee')).toHaveLength(1);
      expect(store.update(id, { fact: 'Stale overwrite' }, original.updated_at).error).toBe('conflict');
      expect(store.getById(id).fact).toBe('New coffee preference');
      store.delete(id);
      expect(store.searchFullText('coffee')).toEqual([]);
      expect(store.searchByTags(['preference'], undefined)).toEqual([]);
      expect(store.getBySession('original')).toEqual([]);
    } finally { store.close(); }
  });
  it('excludes expired facts from Latin, CJK and tag retrieval and retains explicit conflict state', () => {
    const store = new FactStore(':memory:');
    const copy = new FactStore(':memory:');
    try {
      const { id } = store.add({ fact: 'jasmine 茉莉花茶', tags: ['drink'] });
      const current = store.getById(id);
      const expired = store.update(id, { status: 'expired' }, current.updated_at).memory;
      expect(store.searchFullText('jasmine')).toEqual([]);
      expect(store.searchFullText('茉莉')).toEqual([]);
      expect(store.searchByTags(['drink'], undefined)).toEqual([]);
      copy.importAll(store.exportAll());
      expect(copy.getById(1).status).toBe('expired');
      const conflict = store.update(id, { status: 'conflict' }, expired.updated_at).memory;
      expect(conflict.status).toBe('conflict');
      expect(store.searchFullText('jasmine')).toEqual([]);
      expect(store.getAll()[0].status).toBe('conflict');
      expect(store.update(id, { status: 'unknown' }, conflict.updated_at).error).toBe('invalid_status');
      expect(store.update(id, { fact: ' ' }, conflict.updated_at).error).toBe('invalid_fact');
    } finally { store.close(); copy.close(); }
  });
});

it('search withholds unresolved conflicts while governance retains their evidence', async () => {
  const store = new FactStore(':memory:');
  try {
    store.add({ fact: 'Conflicting preference', tags: ['preference'], source: 'document:original', status: 'conflict' });
    const result = await createMemorySearchTool(store).execute('test', { query: 'preference', tags: ['preference'] });
    expect(result.content[0].text).not.toContain('Conflicting preference');
    expect(store.getAll()[0]).toMatchObject({source: 'document:original', status: 'conflict'});
  } finally { store.close(); }
});
