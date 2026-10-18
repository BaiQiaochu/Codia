import { deflateSync } from 'node:zlib';
import { normalizeProviderPayload } from '../../core/provider-compat.ts';
import { buildProviderCompatOptions } from '../../core/llm-request-policy.ts';
import { modelSupportsImageInput } from '../../shared/model-capabilities.ts';
import type { ModelCapability } from './types.ts';

export const OUTPUT_TOKEN_CAP = 256;
export const QUALIFICATION_MARKER = 'codia_capability_17';
const SDK_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
const SCHEMA_APIS = new Set(['openai-completions', 'openai-responses']);
const schema = {
  type: 'object', properties: { marker: { type: 'string', enum: [QUALIFICATION_MARKER] }, count: { type: 'integer', enum: [3] } },
  required: ['marker', 'count'], additionalProperties: false,
};

/** Unknown transport behavior cannot be turned into a successful probe by metadata. */
export function unsupportedReason(model: any, capability: ModelCapability): string | null {
  if (!SDK_APIS.has(model?.api)) return 'unsupported_provider_api';
  if (model?.type && model.type !== 'chat') return 'not_chat_model';
  if (capability === 'tool' && (model.toolCalling === false || model.toolUse === false)) return 'tools_disabled';
  if (capability === 'vision' && !modelSupportsImageInput(model)) return 'image_input_not_configured';
  if (capability === 'structured' && !SCHEMA_APIS.has(model.api)) return 'native_schema_transport_unsupported';
  return null;
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** A real tiny, opaque PNG: no text answer, URL or external image dependency. */
function imageFixture() {
  const width = 64, height = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (1 + width * 3) + 1 + x * 3;
    pixels[at + (x < width / 2 ? 0 : 2)] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

export function buildQualificationCase(capability: ModelCapability, timestamp: number) {
  const prompts: Record<ModelCapability, string> = {
    text: `Reply with exactly ${QUALIFICATION_MARKER} and no other characters.`,
    tool: `Call codia_capability_echo exactly once with marker ${QUALIFICATION_MARKER} and count 3. Do not answer in prose. This tool is a harmless capability fixture.`,
    vision: 'Identify the solid colors of the left and right halves of this image. Reply with only the two lowercase English color names, separated by a comma, with no spaces.',
    structured: `Return a JSON object with marker equal to ${QUALIFICATION_MARKER} and count equal to 3. No other properties or prose.`,
  };
  const content: any[] = [{ type: 'text', text: prompts[capability] }];
  if (capability === 'vision') content.push({ type: 'image', mimeType: 'image/png', data: imageFixture() });
  return {
    systemPrompt: 'You are running a short capability check. Follow the output contract exactly.',
    messages: [{ role: 'user', content, timestamp }],
    ...(capability === 'tool' ? { tools: [{ name: 'codia_capability_echo', description: 'Returns the supplied test marker and count. No external action.', parameters: schema }] } : {}),
  };
}

/** Adapt a native schema through the existing provider payload/compatibility entry point. */
export function buildQualificationPayload(payload: any, model: any, capability: ModelCapability, outputCap = OUTPUT_TOKEN_CAP) {
  const next = normalizeProviderPayload(payload, model, buildProviderCompatOptions({ mode: 'utility', callPurpose: 'health_check', explicitMaxTokens: outputCap, outputBudgetSource: 'user' }));
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('invalid_provider_payload');
  if (capability === 'tool') {
    const tool = Array.isArray(next.tools) && next.tools.find((item: any) => (item.function?.name || item.name) === 'codia_capability_echo');
    const parameters = tool && (tool.function?.parameters || tool.parameters || tool.input_schema);
    if (!parameters || parameters.type !== 'object' || parameters.properties?.marker?.type !== 'string' || parameters.properties?.count?.type !== 'integer'
        || parameters.additionalProperties !== false || !parameters.required?.includes('marker') || !parameters.required?.includes('count')) throw new Error('tool_definition_not_transmitted');
  }
  if (capability === 'vision' && !JSON.stringify(next).includes(imageFixture())) throw new Error('image_fixture_not_transmitted');
  if (capability === 'structured') {
    if (model.api === 'openai-completions') {
      next.response_format = { type: 'json_schema', json_schema: { name: 'codia_capability', strict: true, schema } };
    } else if (model.api === 'openai-responses') {
      next.text = { ...(next.text || {}), format: { type: 'json_schema', name: 'codia_capability', strict: true, schema } };
    } else throw new Error('native_schema_transport_unsupported');
  }
  // Re-clamp after all compatibility adapters. No implicit larger reasoning budget.
  if (model.api === 'openai-responses') next.max_output_tokens = outputCap;
  else if (model.api === 'google-generative-ai') {
    next.config = { ...(next.config || {}), maxOutputTokens: outputCap };
  } else if ('max_completion_tokens' in next) {
    next.max_completion_tokens = outputCap;
    delete next.max_tokens;
  } else next.max_tokens = outputCap;
  if ('n' in next) next.n = 1;
  if (Array.isArray(next.tools) && next.tools.some((tool: any) => tool.type && !['function', 'custom'].includes(tool.type))) throw new Error('provider_hosted_tool_unsupported');
  return next;
}

function exactObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'count,marker' && value.marker === QUALIFICATION_MARKER && value.count === 3;
}

export function validateQualificationResponse(capability: ModelCapability, response: any, payloadObserved: boolean): string | null {
  if (!payloadObserved) return 'provider_payload_unobserved';
  if (!response || ['error', 'aborted', 'length'].includes(response.stopReason)) return 'provider_response_failed';
  const content = Array.isArray(response.content) ? response.content : [];
  const calls = content.filter((block: any) => block?.type === 'toolCall');
  const text = content.filter((block: any) => block?.type === 'text').map((block: any) => block.text || '').join('').trim();
  if (capability === 'tool') {
    return calls.length === 1 && calls[0].name === 'codia_capability_echo' && exactObject(calls[0].arguments) && response.stopReason === 'toolUse' ? null : 'tool_contract_failed';
  }
  if (response.stopReason !== 'stop') return 'provider_response_incomplete';
  if (calls.length) return 'unexpected_tool_call';
  if (capability === 'text') return text === QUALIFICATION_MARKER ? null : 'text_contract_failed';
  if (capability === 'vision') return text === 'red,blue' ? null : 'vision_contract_failed';
  try { return exactObject(JSON.parse(text)) ? null : 'schema_contract_failed'; }
  catch { return 'schema_contract_failed'; }
}
