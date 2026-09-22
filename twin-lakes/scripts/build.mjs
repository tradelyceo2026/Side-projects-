// Build the browser app.
//   dist/twin-lakes.html          the page with the JavaScript inlined; loads the world from data/ (or ../data/)
//   dist/twin-lakes.artifact.html the same page without the document skeleton, for claude.ai artifacts
//   dist/twin-lakes-offline.html  (with --offline) one self-contained file with the world embedded, ~16 MB
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
execSync('npx --yes esbuild@0.21.5 src/main.js --bundle --format=iife --minify --target=es2020 --outfile=dist/bundle.js --log-level=warning',
  { cwd: root, stdio: 'inherit' });
const js = readFileSync(join(root, 'dist', 'bundle.js'), 'utf8').replace(/<\/script>/g, '<\\/script>');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const page = html.replace('<script type="module" src="src/main.js"></script>', () => `<script>\n${js}\n</script>`);
writeFileSync(join(root, 'dist', 'twin-lakes.html'), page);
console.log(`dist/twin-lakes.html ${(page.length / 1048576).toFixed(2)} MB (loads data/)`);
// artifact variant: the host supplies the document skeleton
const inner = page.replace(/^[\s\S]*?<head>\s*/i, '').replace(/<meta[^>]*>\s*/gi, '').replace(/<\/head>\s*<body>\s*/i, '')
  .replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
writeFileSync(join(root, 'dist', 'twin-lakes.artifact.html'), inner);
if (process.argv.includes('--offline')) {
  const data = {};
  for (const f of readdirSync(join(root, 'data'))) data[f] = readFileSync(join(root, 'data', f)).toString('base64');
  const embed = `<script>window.__TL_DATA=${JSON.stringify(data)};</script>`;
  const off = page.replace('<script>\n', () => `${embed}\n<script>\n`);
  writeFileSync(join(root, 'dist', 'twin-lakes-offline.html'), off);
  console.log(`dist/twin-lakes-offline.html ${(off.length / 1048576).toFixed(2)} MB (self-contained)`);
}
