import { Hono } from 'hono';
import { strictJson, isInvalidJsonBodyError } from '../hono-helpers.ts';
import { getModelQualificationService } from '../../lib/model-qualification/index.ts';

/** Owner-only by the normal route policy. Never runs probes during GET/preflight. */
export function createModelQualificationRoute(engine: any) {
  const route = new Hono();
  const service = getModelQualificationService(engine);
  route.get('/models/qualification', c => {
    const id = c.req.query('modelId'), provider = c.req.query('provider');
    if ((id && !provider) || (provider && !id)) return c.json({ error: 'model_id_and_provider_required' }, 400);
    const modelRef = id && provider ? { id, provider } : undefined;
    return c.json({ qualification: service.inspect({ modelRef }) });
  });
  route.post('/models/qualification', async c => {
    try {
      const body = await strictJson(c);
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.manual !== true) return c.json({ error: 'manual_qualification_required' }, 400);
      if (body.mediaTokenAccountingConfirmed !== undefined && typeof body.mediaTokenAccountingConfirmed !== 'boolean') return c.json({ error: 'invalid_media_accounting_confirmation' }, 400);
      // Only recognized data crosses the boundary. No injected callbacks, pass flags,
      // endpoints, credentials or stored reports can be supplied over HTTP.
      const report = await service.qualify({ manual: true, modelRef: body.modelRef, capabilities: body.capabilities, budget: body.budget,
        mediaTokenAccountingConfirmed: body.mediaTokenAccountingConfirmed === true, signal: c.req.raw.signal });
      return c.json({ ok: true, report, qualification: service.inspect({ modelRef: body.modelRef }) });
    } catch (error) {
      if (isInvalidJsonBodyError(error)) return c.json({ error: 'invalid_json_body' }, 400);
      const code = error instanceof Error ? error.message : '';
      if (['manual_qualification_required', 'invalid_qualification_capabilities', 'invalid_qualification_budget', 'qualification_model_required'].includes(code)) return c.json({ error: code }, 400);
      if (code === 'qualification_already_running') return c.json({ error: code }, 409);
      // Resolver/transport errors may contain endpoint URLs or credentials. Do not echo them.
      return c.json({ error: 'qualification_configuration_or_storage_unavailable' }, 422);
    }
  });
  return route;
}
