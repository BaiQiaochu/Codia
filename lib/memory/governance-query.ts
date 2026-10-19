/** Bounded, literal governance queries. No model invocation or recall-scope changes. */
export type GovernanceQuery = {limit?:number;offset?:number;q?:string;projectId?:string;source?:string;status?:string;from?:string;to?:string;reviewOnly?:boolean};
export class GovernanceQueryError extends Error {}
export function normalizeGovernanceQuery(input: GovernanceQuery = {}) {
  const limit = input.limit ?? 25, offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new GovernanceQueryError('limit must be 1–100 and offset nonnegative');
  for (const key of ['q','projectId','source','status'] as const) if (input[key] != null && (typeof input[key] !== 'string' || input[key]!.length > 1024)) throw new GovernanceQueryError(`Invalid ${key}`);
  for (const key of ['from','to'] as const) if (input[key] && !Number.isFinite(Date.parse(input[key]!))) throw new GovernanceQueryError(`Invalid ${key}`);
  const from = input.from ? new Date(input.from).toISOString() : undefined;
  const to = input.to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.to) ? `${input.to}T23:59:59.999Z` : input.to).toISOString() : undefined;
  if (from && to && from > to) throw new GovernanceQueryError('from must not be later than to');
  return {...input,limit,offset,from,to};
}
export function governanceQueryFromParams(query: Record<string,string>) {
  return normalizeGovernanceQuery({...Object.fromEntries(['q','projectId','source','status','from','to'].filter(key => query[key]).map(key => [key,query[key]])),
    limit:query.limit === undefined ? undefined:Number(query.limit),offset:query.offset === undefined ? undefined:Number(query.offset),reviewOnly:query.reviewOnly === 'true'});
}
export function literalLike(value: string) { return `%${value.replace(/[\\%_]/g,'\\$&')}%`; }
export function projectOption(id: string) { return {id,label:id.replace(/^workspace:/,'').split(/[\\/]/).filter(Boolean).at(-1) || id}; }
