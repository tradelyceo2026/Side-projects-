// Browser check: serve the page, boot it in headless Chromium, collect errors, take screenshots.
//   node scripts/e2e.mjs [dist]   (dist: test dist/twin-lakes.html instead of the dev page)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(`${process.execPath.replace(/bin\/node$/, 'lib/node_modules')}/playwright`); }
const { chromium } = pw;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const useDist = process.argv.includes('dist');
const outDir = path.join(root, '.cache', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = useDist ? '/dist/twin-lakes.html' : '/index.html';
  const f = path.join(root, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 960), height: +(process.env.H || 540) } });
page.setDefaultTimeout(180000);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(`http://localhost:${port}/?q=${process.env.Q || 'low'}`);
await page.waitForFunction(() => window.__twinlakes?.sim, null, { timeout: 180000 });
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); console.log(`shot ${name}`); };
await page.waitForTimeout(4000);
console.log(errors.filter((e) => !/program not valid/.test(e)).slice(0, 6).join('\n').slice(0, 6000));
await shot('01-menu');
// SHOTS=scenario:camera:time:seconds,... takes clean beauty shots with the HUD hidden
if (process.env.SHOTS) {
  let i = 0;
  for (const spec of process.env.SHOTS.split(',')) {
    const [sc, cam, time, secs] = spec.split(':');
    await page.evaluate(([s, c, t]) => {
      const a = window.__twinlakes; a.settings.time = t || 'noon'; a.settings.weather = 'fair'; a.start(s);
      a.rig.set(c || 'chase'); document.querySelector('#hud').style.display = 'none';
    }, [sc, cam, time]);
    await page.waitForTimeout(+(secs || 5) * 1000);
    await shot(`b${String(++i).padStart(2, '0')}-${sc}-${cam}-${time}`);
  }
}
const steps = (process.env.STEPS || (process.env.SHOTS ? '' : 'takeoff')).split(',').filter(Boolean);
for (const sc of steps) {
  await page.evaluate(([s, time, wx]) => { const a = window.__twinlakes; a.settings.time = time; a.settings.weather = wx; a.start(s); },
    [sc, process.env.TIME || 'noon', process.env.WX || 'fair']);
  await page.waitForTimeout(5000);
  await shot(`02-${sc}-chase`);
  await page.keyboard.press('v');
  await page.waitForTimeout(2500);
  await shot(`03-${sc}-cockpit`);
  await page.keyboard.press('v');
}
const info = await page.evaluate(() => { const a = window.__twinlakes; return { fps: a.fpsAvg, nodes: a.terrainR.stats.nodes, crashed: a.sim.a.crashed, pos: a.sim.a.pos, calls: a.renderer.info.render.calls, tris: a.renderer.info.render.triangles }; });
console.log(JSON.stringify(info));
console.log(errors.slice(0, 40).join('\n') || 'no console errors');
await browser.close();
server.close();
