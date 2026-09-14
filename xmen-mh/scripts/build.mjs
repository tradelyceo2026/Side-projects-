// Bundle the game into a single HTML file with esbuild (three.js + all modules inlined).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
execSync(`npx --yes esbuild@0.21.5 src/main.js --bundle --format=iife --minify --target=es2020 --outfile=dist/bundle.js --log-level=warning`, { cwd: root, stdio: 'inherit' });
const js = readFileSync(join(root, 'dist', 'bundle.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const out = html.replace('<script type="module" src="src/main.js"></script>', () => `<script>\n${js}\n</script>`);
writeFileSync(join(root, 'dist', 'xmen-mh.html'), out);
const inner = out.replace(/^[\s\S]*?<head>\s*/i, '').replace(/<meta[^>]*>\s*/gi, '').replace(/<\/head>\s*<body>\s*/i, '').replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
writeFileSync(join(root, 'dist', 'xmen-mh.artifact.html'), inner);
console.log(`dist/xmen-mh.html written (${(out.length / 1048576).toFixed(2)} MB)`);
