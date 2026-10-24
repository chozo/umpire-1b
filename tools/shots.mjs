// 見た目の確認用: プレーの各時点を撮る。使い方: node tools/shots.mjs [seed] [index] [margin]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const URL = process.env.URL ?? 'http://localhost:5289/';
const OUT = 'tools/out/shots';
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const seed = Number(process.argv[2] ?? 3);
const index = Number(process.argv[3] ?? 10);
const margin = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
const fielder = process.argv[5];
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 405, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${URL}?seed=${seed}`);
await page.waitForFunction(() => window.__game);
await page.evaluate(() => window.__game.manual(true));
await page.screenshot({ path: `${OUT}/00-title.png` });
await page.evaluate(([i, m, f]) => {
  const g = window.__game;
  g.start();
  const force = {};
  if (m !== undefined) force.margin = m;
  if (f) force.fielder = f;
  g.replay(force);
}, [index, margin, fielder]);
const st = () => page.evaluate(() => window.__game.state());
const step = (sec) => page.evaluate((s) => window.__game.step(1 / 60, Math.round(s * 60)), sec);
let s = await st();
console.log(JSON.stringify(s.play));
const shotAt = async (t, name) => {
  s = await st();
  if (t > s.t) await step(t - s.t);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
const p = s.play;
await shotAt(p.tHit - 0.3, '01-pitch');
await shotAt(p.tHit + 0.5, '02-hit');
await shotAt(p.tField, '03-field');
await shotAt(p.tRelease, '04-release');
await shotAt(Math.min(p.tCatch, p.tArrive) - 0.25, '05-approach');
await shotAt(Math.max(p.tCatch, p.tArrive) + 0.01, '06-moment');
console.log(JSON.stringify(await page.evaluate(() => window.__game.probe())));
await page.evaluate(() => window.__game.call('out'));
await step(1.1);
await page.screenshot({ path: `${OUT}/07-called.png` });
s = await st();
console.log('phase', s.phase, s.requestSide);
if (s.phase === 'request') {
  await step(1.0);
  await page.screenshot({ path: `${OUT}/08-request-a.png` });
  await step(1.0);
  await page.screenshot({ path: `${OUT}/09-request-b.png` });
  await step(1.2);
  await step(1.0);
  await page.screenshot({ path: `${OUT}/10-replay-r1.png` });
  for (let i = 0; i < 400; i++) {
    s = await st();
    if (s.replaySub !== 'r1') break;
    await step(0.1);
  }
  await step(0.6);
  await page.screenshot({ path: `${OUT}/11-split.png` });
  const ev = [];
  for (let i = 0; i < 600; i++) {
    const e = await page.evaluate(() => window.__game.drainEvents());
    ev.push(...e);
    if (e.some((x) => x.type === 'stamp')) {
      await page.screenshot({ path: `${OUT}/12-stamp-${e.find((x) => x.type === 'stamp').args[0]}.png` });
    }
    s = await st();
    if (s.replaySub === 'r3') break;
    await step(1 / 30);
  }
  await step(0.5);
  await page.screenshot({ path: `${OUT}/13-result.png` });
}
console.log('errors', errors);
await browser.close();
