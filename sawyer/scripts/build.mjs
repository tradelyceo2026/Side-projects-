// Bundle Sawyer into a single HTML file: vendor muxers + ES modules (import/export stripped) inlined.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const order = ['model', 'media', 'engine', 'export', 'ai', 'timeline', 'panels', 'app'];
let code = '';
for (const name of order) {
  let src = readFileSync(join(root, 'src', `${name}.js`), 'utf8');
  src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '');
  src = src.replace(/^export\s+(const|let|function|class|async function)\s/gm, '$1 ');
  // `import * as M from './model.js'` users reference M.x — provide M as an object of the model exports
  code += `\n// ===== src/${name}.js =====\n${src}\n`;
}
// model namespace object for app.js (which uses M.*)
const modelSrc = readFileSync(join(root, 'src', 'model.js'), 'utf8');
const names = [...modelSrc.matchAll(/^export\s+(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
code = `const M = {};\n` + code + `\nObject.assign(M, { ${names.join(', ')} });\n`;
// M must be assigned before app.js runs its boot(); app.js is last and only *calls* M.* at runtime, but
// `app.project = M.createProject()` runs at load: so move the assignment before app.js.
const marker = '\n// ===== src/app.js =====\n';
const [before, after] = code.split(marker);
code = before.replace(/\nObject\.assign\(M, \{[^\n]*\n$/, '') + `\nObject.assign(M, { ${names.join(', ')} });\n` + marker + after.replace(/\nObject\.assign\(M, \{[^\n]*\n$/, '');
const vendor = ['mp4-muxer', 'webm-muxer'].map(v => readFileSync(join(root, 'vendor', `${v}.js`), 'utf8')).join('\n');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const out = html
  .replace('<script src="vendor/mp4-muxer.js"></script>\n<script src="vendor/webm-muxer.js"></script>\n', `<script>\n${vendor}\n</script>\n`)
  .replace('<script type="module" src="src/app.js"></script>', `<script>\n(() => {\n'use strict';\n${code}\n})();\n</script>`);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'sawyer.html'), out);
const inner = out.replace(/^[\s\S]*?<head>\s*/i, '').replace(/<meta[^>]*>\s*/gi, '').replace(/<\/head>\s*<body>\s*/i, '').replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
writeFileSync(join(root, 'dist', 'sawyer.artifact.html'), inner);
console.log(`dist/sawyer.html (${(out.length / 1024).toFixed(0)} KB), dist/sawyer.artifact.html written`);
