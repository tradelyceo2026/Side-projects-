// Bundle the ES modules into a single self-contained HTML file (dist/ozark-orbital.html).
// The modules are written so a simple import/export strip is enough — no bundler needed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const order = ['physics', 'vehicle', 'sim', 'autopilot', 'render', 'missions', 'game'];
let code = '';
for (const name of order) {
  let src = readFileSync(join(root, 'src', `${name}.js`), 'utf8');
  src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '');
  src = src.replace(/^export\s+(const|let|function|class)\s/gm, '$1 ');
  code += `\n// ===== src/${name}.js =====\n${src}\n`;
}
const html = readFileSync(join(root, 'index.html'), 'utf8');
const out = html.replace('<script type="module" src="src/game.js"></script>', `<script>\n(() => {\n'use strict';\n${code}\n})();\n</script>`);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'ozark-orbital.html'), out);
console.log(`dist/ozark-orbital.html written (${(out.length / 1024).toFixed(0)} KB)`);

// Artifact flavour: same page without the document skeleton (the host supplies it).
const inner = out
  .replace(/^[\s\S]*?<head>\s*/i, '')
  .replace(/<meta[^>]*>\s*/gi, '')
  .replace(/<\/head>\s*<body>\s*/i, '')
  .replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
writeFileSync(join(root, 'dist', 'ozark-orbital.artifact.html'), inner);
console.log(`dist/ozark-orbital.artifact.html written (${(inner.length / 1024).toFixed(0)} KB)`);
