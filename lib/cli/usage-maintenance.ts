import { CliError } from './errors.ts';
/** API-backed settings: uses the CLI's existing local authentication, never opens a second database. */
export async function commandUsage(client: any, args: string[], _opts?: unknown, write = (value: unknown) => console.log(JSON.stringify(value, null, 2))) {
  const [kind = 'report', target, operation, value, ...rest] = args;
  if (kind === 'report' && args.length === 1 || args.length === 0) return write(await client.get('/api/usage/llm?limit=500'));
  if (kind === 'budget') {
    if (!target) return write(await client.get('/api/usage/budget'));
    if (target !== 'set' || !operation || args.length !== 3) throw new CliError('usage budget set <JSON config>');
    let config; try { config = JSON.parse(operation); } catch { throw new CliError('Budget configuration must be JSON'); }
    const previous = await client.get('/api/usage/budget');
    return write(await client.request('PATCH', '/api/usage/budget', { body: { config, expectedRevision: previous.revision } }));
  }
  if (kind === 'retention' && target) {
    const url = `/api/memories/maintenance?agentId=${encodeURIComponent(target)}`;
    const previous = await client.get(url);
    if (!operation) return write(previous);
    if (operation === 'set' && value && !rest.length) {
      let policy; try { policy = JSON.parse(value); } catch { throw new CliError('Retention policy must be JSON'); }
      return write(await client.request('PATCH', url, { body: { policy, expectedRevision: previous.revision } }));
    }
    if (operation === 'apply' && value === '--confirm' && !rest.length) return write(await client.post(url, { confirmed: true, expectedRevision: previous.revision }));
    throw new CliError('usage retention <agentId> [set <JSON policy> | apply --confirm]');
  }
  throw new CliError('usage report | budget [set <JSON>] | retention <agentId> [set <JSON> | apply --confirm]');
}
