import path from 'node:path';
import ts from 'typescript';

export type InlineModelAsset = { source: Buffer; mime: string; maxSourceBytes: number };
export type RendererBudgetOptions = {
  chunks: Map<string, string>;
  entryChunks: string[];
  modelAssets: InlineModelAsset[];
  defaultBudget: number;
  getBudget(name: string): number;
};

function moduleInfo(source: string) {
  const parsed = ts.createSourceFile('chunk.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const statics: string[] = [], dynamics: string[] = [], dataUrls: string[] = [];
  let exportsLive2D = false;
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      statics.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      dynamics.push(node.arguments[0].text);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      exportsLive2D ||= node.exportClause.elements.some(item => item.name.text === 'createCodiaLive2D');
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createCodiaLive2D' && node.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
      exportsLive2D = true;
    }
    if (ts.isStringLiteralLike(node) && node.text.startsWith('data:')) dataUrls.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return { statics, dynamics, dataUrls, exportsLive2D };
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function rendererHtmlEntries(htmlFiles: string[], chunks: Map<string, string>): string[] {
  const entries = new Set<string>();
  for (const html of htmlFiles) {
    for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const isLink = /^<link/i.test(tag[0]);
      if (isLink && !(htmlAttribute(tag[0], 'rel') || '').toLowerCase().split(/\s+/).includes('modulepreload')) continue;
      const reference = htmlAttribute(tag[0], isLink ? 'href' : 'src');
      if (!reference) continue;
      let name: string;
      try { name = path.posix.basename(decodeURIComponent(reference.split(/[?#]/)[0])); }
      catch { continue; }
      if (chunks.has(name)) entries.add(name);
    }
  }
  return [...entries];
}

/** Account only exact, bounded offline model bytes, never arbitrary runtime code. */
export function auditRendererChunkBudgets(options: RendererBudgetOptions) {
  const { chunks, entryChunks, modelAssets, defaultBudget, getBudget } = options;
  const modules = new Map([...chunks].map(([name, source]) => [name, moduleInfo(source)]));
  const resolve = (from: string, specifier: string) => {
    let reference: string;
    try { reference = decodeURIComponent(specifier.split(/[?#]/)[0]); }
    catch { return null; }
    if (!reference.startsWith('.') && !reference.startsWith('/')) return null;
    const absolute = reference.startsWith('/')
      ? path.posix.normalize(reference)
      : path.posix.resolve('/assets', path.posix.dirname(from), reference);
    const marker = absolute.lastIndexOf('/assets/');
    if (marker < 0) return null;
    const name = absolute.slice(marker + '/assets/'.length);
    return chunks.has(name) ? name : null;
  };
  function reachable(includeDynamic: boolean) {
    const seen = new Set<string>();
    const pending = [...entryChunks];
    while (pending.length) {
      const name = pending.pop()!;
      if (seen.has(name) || !modules.has(name)) continue;
      seen.add(name);
      const entry = modules.get(name)!;
      for (const reference of [...entry.statics, ...(includeDynamic ? entry.dynamics : [])]) {
        const target = resolve(name, reference);
        if (target) pending.push(target);
      }
    }
    return seen;
  }
  const startup = reachable(false), allReachable = reachable(true);
  const errors: string[] = [];
  const candidates = [...modules].filter(([, entry]) => entry.exportsLive2D);
  if (candidates.length > 1) errors.push('Multiple chunks export the Live2D runtime');
  const expected = modelAssets.map(asset => `data:${asset.mime};base64,${asset.source.toString('base64')}`);
  const expectedBase64Bytes = modelAssets.reduce((sum, asset) => sum + Buffer.byteLength(asset.source.toString('base64')), 0);
  const oversized: Array<{ name: string; size: number; codeBytes: number; maxBytes: number }> = [];
  const live2d: Array<{ name: string; size: number; codeBytes: number; inlineBase64Bytes: number }> = [];
  for (const [name, source] of chunks) {
    const entry = modules.get(name)!;
    const size = Buffer.byteLength(source);
    let codeBytes = size, maxBytes = getBudget(name);
    if (entry.exportsLive2D) {
      const problemCount = errors.length;
      if (modelAssets.some(asset => asset.source.length > asset.maxSourceBytes)) errors.push(`${name}: authoritative offline model exceeds its explicit asset bound`);
      // Full string equality includes MIME, canonical base64 and exact authoritative bytes.
      if (entry.dataUrls.length !== expected.length || expected.some(url => entry.dataUrls.filter(found => found === url).length !== 1)) {
        errors.push(`${name}: unknown, changed, duplicated or extra inline model payload`);
      }
      if (startup.has(name)) errors.push(`${name}: Live2D model must not be in the initial static/modulepreload graph`);
      if (!allReachable.has(name)) errors.push(`${name}: Live2D runtime is not reachable from an HTML entry`);
      const dynamicInbound = [...modules].some(([from, info]) => info.dynamics.some(reference => resolve(from, reference) === name));
      if (!dynamicInbound) errors.push(`${name}: Live2D runtime has no explicit lazy import`);
      // No exemption for a filename such as runtime-*. Only the proven module,
      // its two exact payloads, and its lazy reachability qualify for accounting.
      if (errors.length === problemCount && candidates.length === 1) codeBytes -= expectedBase64Bytes;
      maxBytes = defaultBudget;
      live2d.push({ name, size, codeBytes, inlineBase64Bytes: size - codeBytes });
    }
    if (codeBytes > maxBytes) oversized.push({ name, size, codeBytes, maxBytes });
  }
  return { oversized: oversized.sort((a, b) => b.size - a.size), errors, live2d };
}
