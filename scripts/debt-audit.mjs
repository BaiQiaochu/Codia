import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SOURCE_ROOTS = ['cli', 'core', 'desktop', 'hub', 'lib', 'packages', 'plugins', 'scripts', 'server', 'shared'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
const EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'vendor', 'artifacts', 'dist', 'dist-server', 'dist-server-bundle',
  'dist-computer-use', 'dist-sandbox', 'dist-renderer', '.cache', '__tests__', 'test', 'tests',
  'generated', '.build', 'assets', 'coverage',
]);
const MAX_FUNCTION_LINES = 100;
const MAX_COMPLEXITY = 20;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else if (
      SOURCE_EXTENSIONS.has(path.extname(entry.name))
      && !entry.name.endsWith('.d.ts')
      && !entry.name.includes('.bundle.')
      && !entry.name.includes('.generated.')
    ) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function maskStringsAndComments(source) {
  let result = '';
  let mode = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (mode === 'code' && char === '/' && next === '/') { mode = 'line'; result += '  '; i += 1; continue; }
    if (mode === 'code' && char === '/' && next === '*') { mode = 'block'; result += '  '; i += 1; continue; }
    if (mode === 'code' && (char === "'" || char === '"' || char === '`')) { mode = char; result += ' '; continue; }
    if (mode === 'line' && char === '\n') { mode = 'code'; result += '\n'; continue; }
    if (mode === 'block' && char === '*' && next === '/') { mode = 'code'; result += '  '; i += 1; continue; }
    if ((mode === "'" || mode === '"' || mode === '`') && char === '\\') { result += '  '; i += 1; continue; }
    if (mode === char && (char === "'" || char === '"' || char === '`')) { mode = 'code'; result += ' '; continue; }
    result += mode === 'code' || char === '\n' ? char : ' ';
  }
  return result;
}

function moduleSpecifiers(source) {
  const values = [];
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Only eager edges can form an initialization cycle. Dynamic import() is an
  // explicit async boundary and is reported through the bundler instead.
  const pattern = /\b(?:from\s*|require\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(pattern)) values.push(match[1]);
  return values;
}

function resolveLocalImport(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  return candidates.find((candidate) => knownFiles.has(path.normalize(candidate))) || null;
}

function matchingBraces(masked) {
  const stack = [];
  const pairs = new Map();
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '{') stack.push(i);
    else if (masked[i] === '}' && stack.length > 0) pairs.set(stack.pop(), i);
  }
  return pairs;
}

function functionRanges(source, masked) {
  const braces = matchingBraces(masked);
  const patterns = [
    /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
    /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
  ];
  const excludedNames = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
  const seen = new Set();
  const ranges = [];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const open = match.index + match[0].lastIndexOf('{');
      const end = braces.get(open);
      const name = match[1] || '<anonymous>';
      if (end === undefined || seen.has(open) || excludedNames.has(name)) continue;
      seen.add(open);
      ranges.push({
        name,
        line: source.slice(0, match.index).split(/\r?\n/).length,
        text: source.slice(match.index, end + 1),
      });
    }
  }
  return ranges;
}

function functionMetrics(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).length;
  const branches = text.match(/\b(?:if|for|while|catch|case)\b|\?\s*[^.:]|&&|\|\||\?\?/g)?.length ?? 0;
  return { lines, complexity: 1 + branches };
}

function findCycles(graph) {
  let index = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  function connect(node) {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) || []) {
      if (!indexes.has(next)) {
        connect(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (onStack.has(next)) lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || graph.get(node)?.has(node)) cycles.push(component.map(relative).sort());
  }
  for (const node of graph.keys()) if (!indexes.has(node)) connect(node);
  return cycles.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

const files = SOURCE_ROOTS.flatMap((dir) => walk(path.join(ROOT, dir)));
if (fs.existsSync(path.join(ROOT, 'index.js'))) files.push(path.join(ROOT, 'index.js'));
const knownFiles = new Set(files.map(path.normalize));
const graph = new Map();
const noCheckFiles = [];
const longFunctions = [];
const complexFunctions = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (/^\s*\/\/\s*@ts-nocheck/m.test(source)) noCheckFiles.push(relative(file));
  const dependencies = new Set();
  for (const specifier of moduleSpecifiers(source)) {
    const resolved = resolveLocalImport(file, specifier, knownFiles);
    if (resolved) dependencies.add(resolved);
  }
  graph.set(file, dependencies);
  const masked = maskStringsAndComments(source);
  for (const range of functionRanges(source, masked)) {
    const record = { file: relative(file), line: range.line, name: range.name };
    const { lines, complexity } = functionMetrics(range.text);
    if (lines > MAX_FUNCTION_LINES) longFunctions.push({ ...record, lines });
    if (complexity > MAX_COMPLEXITY) complexFunctions.push({ ...record, complexity });
  }
}

longFunctions.sort((a, b) => b.lines - a.lines);
complexFunctions.sort((a, b) => b.complexity - a.complexity);
const cycles = findCycles(graph);
const report = {
  generatedAt: new Date().toISOString(),
  thresholds: { maxFunctionLines: MAX_FUNCTION_LINES, maxCyclomaticComplexity: MAX_COMPLEXITY },
  scannedFiles: files.length,
  summary: {
    tsNoCheckFiles: noCheckFiles.length,
    longFunctions: longFunctions.length,
    complexFunctions: complexFunctions.length,
    dependencyCycles: cycles.length,
  },
  tsNoCheckFiles: noCheckFiles.sort(),
  longFunctions,
  complexFunctions,
  dependencyCycles: cycles,
};

const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const output = outputArg ? path.resolve(ROOT, outputArg.slice('--output='.length)) : null;
if (output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report.summary, null, 2));
if (output) console.log(`Debt report: ${relative(output)}`);
if (process.argv.includes('--strict') && Object.values(report.summary).some((value) => value > 0)) process.exitCode = 1;
