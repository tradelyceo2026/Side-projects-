import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const SCR = process.env.SHOTS || '/tmp/xmen-shots'; import('node:fs').then(fs => fs.mkdirSync(SCR, { recursive: true }));
const file = 'file://' + process.cwd() + '/dist/xmen-mh.html';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [], warns = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); if (m.type() === 'warning') warns.push(m.text().slice(0, 200)); });
const t0 = Date.now();
await page.goto(file);
await page.waitForFunction(() => window.xmen && window.xmen.state, null, { timeout: 180000 });
console.log('booted in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForTimeout(1500);
await page.screenshot({ path: SCR + '/01-title.png' });
const info = await page.evaluate(() => { const r = window.xmen.state.renderer.info; return { calls: r.render.calls, tris: r.render.triangles, geoms: r.memory.geometries, tex: r.memory.textures, pois: ['courthouse','asumh','hospital','walmart','landing_zone'].map(id => { const p = window.xmen.city.poi(id); return p ? id + '@' + Math.round(p.x) + ',' + Math.round(p.z) : id + ':MISSING'; }) }; });
console.log('render info', JSON.stringify(info));
// start the game
await page.evaluate(() => { window.__ev = []; for (const e of ['dialog', 'phase', 'dialog_advance', 'mission_start', 'objective_update']) window.xmen.bus.on(e, (p) => window.__ev.push(((performance.now() / 1000) | 0) + 's ' + e + ':' + (p.speaker || p.phase || p.id || p.text || ''))); });
await page.keyboard.press('Enter'); await page.waitForTimeout(300); await page.evaluate(() => window.xmen.startGame());
await page.waitForTimeout(2500);
await page.screenshot({ path: SCR + '/02-intro.png' });
// skip dialog
for (let i = 0; i < 150; i++) { if (await page.evaluate(() => window.xmen.state.phase === 'deck')) break; await page.keyboard.press('KeyE'); await page.waitForTimeout(400); }
console.log('phase now', await page.evaluate(() => window.xmen.state.phase)); console.log((await page.evaluate(() => window.__ev.slice(0, 20))).join(' | '));
await page.waitForFunction(() => window.xmen.state.phase === 'deck', null, { timeout: 30000 });
await page.waitForTimeout(800);
await page.screenshot({ path: SCR + '/03-deck.png' });
console.log('deck player', await page.evaluate(() => { const p = window.xmen.state.player; return JSON.stringify({ x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1), hp: p.hp, ch: p.character }); }));
// walk forward a bit then jump
await page.keyboard.down('KeyW'); await page.waitForTimeout(1500); await page.keyboard.up('KeyW');
await page.evaluate(() => window.xmen.jump());
await page.waitForFunction(() => window.xmen.state.phase === 'skydive', null, { timeout: 10000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: SCR + '/04-skydive.png' });
for (let i = 0; i < 40; i++) { const st = await page.evaluate(() => ({ ph: window.xmen.state.phase, y: Math.round(window.xmen.state.player.pos.y), vy: Math.round(window.xmen.state.player.vel.y), fps: window.__fps || 0 })); if (i % 4 === 0) console.log('skydive', JSON.stringify(st)); if (st.ph === 'play') break; await page.waitForTimeout(10000); }
await page.waitForFunction(() => window.xmen.state.phase === 'play', null, { timeout: 60000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: SCR + '/05-landed.png' });
console.log('landed', await page.evaluate(() => { const p = window.xmen.state.player; const m = window.xmen.missions.current && window.xmen.missions.current(); return JSON.stringify({ x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1), mission: m && (m.mission ? m.mission.id : m.id), objective: m && m.objective && m.objective.text }); }));
// combat smoke: spawn thugs nearby, switch characters, use abilities
await page.evaluate(() => { const p = window.xmen.state.player.pos; window.xmen.enemies.spawnWave({ kind: 'thug', count: 4, around: { x: p.x, z: p.z }, radius: 6 }); });
await page.waitForTimeout(500);
const hold = async (k, ms = 700) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); await page.waitForTimeout(300); };
const snap = async (label) => console.log(label, await page.evaluate(() => ({ ch: window.xmen.state.player.character, ts: +window.xmen.state.timeScale.toFixed(2), enemies: window.xmen.enemies.all().map(e => Math.round(e.hp)).join('/') })));
await hold('Digit1'); await hold('KeyJ'); await hold('KeyJ'); await hold('KeyJ'); await snap('wolverine combo');
await hold('KeyK'); await snap('claws');
await hold('Digit2'); await hold('KeyQ'); await snap('quicksilver slowmo');
await hold('KeyK'); await snap('dash');
await hold('Digit3'); await hold('KeyK'); await snap('jean tk');
await hold('Digit4'); await hold('KeyK', 1500); await snap('cyclops blast');
await hold('Digit5'); await hold('KeyK'); await hold('KeyQ'); await snap('emma');
await page.waitForTimeout(800);
await page.screenshot({ path: SCR + '/06-combat.png' });
const after = await page.evaluate(() => ({ enemies: window.xmen.enemies.all().map(e => e.kind + ':' + Math.round(e.hp)), hp: window.xmen.state.player.hp, ch: window.xmen.state.player.character, timeScale: window.xmen.state.timeScale, calls: window.xmen.state.renderer.info.render.calls, loopErr: !!window.xmen.state._loopErr }));
console.log('after combat', JSON.stringify(after));
// fps sample
const fps = await page.evaluate(() => new Promise(res => { let n = 0; const t = performance.now(); const tick = () => { n++; if (performance.now() - t > 2000) res(+(n / ((performance.now() - t) / 1000)).toFixed(1)); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
console.log('fps (software GL)', fps);
// teleport to the mansion for a screenshot
await page.evaluate(() => { const p = window.xmen.city.poi('asumh'); window.xmen.player.teleport(p.x + 30, p.z + 30); });
await page.waitForTimeout(1200);
await page.screenshot({ path: SCR + '/07-campus.png' });
console.log('errors', errors.slice(0, 12));
console.log('warnings', warns.slice(0, 5));
await browser.close();
