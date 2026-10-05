export interface BuildCardDocumentOptions {
  code: string;
  varsCss?: string;
}

function sanitizeVarsCss(varsCss: string): string {
  return varsCss.replace(/[<>]/g, "");
}

export function buildCardDocument(options: BuildCardDocumentOptions): string {
  const code = typeof options.code === "string" ? options.code : "";
  const safeVars = sanitizeVarsCss(typeof options.varsCss === "string" ? options.varsCss : "");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
${safeVars}
  --font-serif: 'EB Garamond', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif;
  --font-ui: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { background: var(--bg-card, #FFFDF7); color: var(--text, #1B365D); }
body { padding: 12px 16px; font-family: var(--font-serif); font-size: 14px; line-height: 1.65; }
h1 { font-size: 1.35rem; font-weight: 600; line-height: 1.25; margin: 0 0 0.6em; }
h2 { font-size: 1.1rem; font-weight: 600; line-height: 1.3; margin: 0.8em 0 0.4em; border-left: 2px solid var(--accent, #537D96); padding-left: 8px; }
h3 { font-size: 0.95rem; font-weight: 600; line-height: 1.35; margin: 0.6em 0 0.3em; }
p { margin: 0.4em 0; }
small { font-size: 0.75rem; color: var(--text-muted, #6B6158); }
strong { font-weight: 600; color: var(--accent, #537D96); }
a { color: var(--accent, #537D96); text-decoration: none; }
hr { border: none; border-top: 0.5px solid var(--border, #D8CFBE); margin: 0.8em 0; }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.6em 0; }
th { text-align: left; font-weight: 600; color: var(--text, #1B365D); padding: 6px 8px; border-bottom: 1px solid var(--border, #D8CFBE); }
td { padding: 5px 8px; border-bottom: 0.5px solid rgba(0,0,0,0.08); color: var(--text, #1B365D); }
tr:last-child td { border-bottom: none; }
ul, ol { padding-left: 18px; margin: 0.4em 0; }
li { margin: 0.15em 0; }
li::marker { color: var(--accent, #537D96); }
pre { background: var(--bg, #F5EFE4); border: 0.5px solid var(--border, #D8CFBE); border-radius: 4px; padding: 8px 12px; overflow-x: auto; }
code { font-family: var(--font-mono); font-size: 0.82rem; color: var(--text, #1B365D); }
blockquote { border-left: 2px solid var(--accent, #537D96); padding: 4px 0 4px 12px; color: var(--text-muted, #6B6158); font-style: italic; margin: 0.5em 0; }
svg { display: block; width: 100%; max-width: 100%; }
svg text { font-family: var(--font-serif); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
</style>
</head>
<body>
${code}
<script>
(function() {
  var NS = 'gsap.card-resize';
  var last = 0;
  function report() {
    var h = document.documentElement.scrollHeight;
    if (h !== last) {
      last = h;
      window.parent.postMessage({ type: NS, height: h }, '*');
    }
  }
  if (document.readyState === 'complete') report();
  else window.addEventListener('load', report);
  new ResizeObserver(function() { report(); }).observe(document.body);
  window.addEventListener('message', function(e) {
    if (e.data === 'gsap.card-ping') {
      last = 0;
      report();
    }
  });
})();
</script>
</body>
</html>`;
}
