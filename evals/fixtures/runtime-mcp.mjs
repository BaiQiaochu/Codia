import readline from 'node:readline';
import process from 'node:process';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id == null) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'codia-local-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Local deterministic echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: request.params.arguments.text }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
