// SNS共有用の画像 public/ogp.png（1200×630）を作る。npm run ogp [URL]（開発サーバーを起動しておく）
// 際どいプレーの「塁審の目線」と「上下2画面のスーパースロー」を撮り、タイトルと並べる
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
const GAME_URL = process.argv[2] || 'http://localhost:5289/';
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
  await page.goto(GAME_URL + '?seed=7');
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => window.__game.manual(true));
  const g = (fn, arg) => page.evaluate(fn, arg);
  const state = () => g(() => window.__game.state());
  const step = (sec, dt = 1 / 60) => g(([s, d]) => window.__game.step(d, Math.max(1, Math.round(s / d))), [sec, dt]);
  const until = async (cond, dt = 1 / 60) => {
    for (let i = 0; i < 4000; i++) {
      const s = await state();
      if (cond(s)) return s;
      await step(dt, dt);
    }
    throw new Error('until: timeout');
  };
  await page.click('#btn-start');
  await page.addStyleTag({ content: '#controls{display:none!important}' });
  await g(() => window.__game.replay({ margin: 0.012, fielder: 'SS' }));
  const s = await state();
  // 捕球の少し前（走者がベースに迫り、送球がミットへ向かう）
  await step(s.play.tCatch - 0.08 - s.t, 1 / 120);
  await page.waitForTimeout(300);
  await g(() => window.__game.step(0));
  const live = await page.screenshot({ type: 'png' });
  await step(s.play.tArrive + 0.3 - (await state()).t, 1 / 60);
  await until((x) => x.armed);
  await g(() => window.__game.call('safe'));
  await until((x) => x.phase === 'replay' && x.replaySub === 'r2', 1 / 20);
  // 両方の瞬間に印が付くところまで進める
  await until((x) => x.rt >= Math.max(x.play.tArrive, x.play.tCatch) + 0.001, 1 / 60);
  await page.waitForTimeout(300);
  await g(() => window.__game.step(0));
  const split = await page.screenshot({ type: 'png' });

  const img = (b) => `data:image/png;base64,${b.toString('base64')}`;
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await card.setContent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{margin:0;width:1200px;height:630px;overflow:hidden;color:#fff;font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif;
      background:radial-gradient(ellipse at 25% 110%,#a0683a 0,#6b4423 28%,transparent 60%),radial-gradient(circle at 10% 0%,#fff3 0,transparent 25%),radial-gradient(circle at 40% -5%,#fff2 0,transparent 22%),linear-gradient(#0f1a2e,#13233d)}
    .copy{position:absolute;left:64px;top:132px;width:580px}
    .brand{font-size:18px;letter-spacing:7px;color:#9fc2e6;font-weight:700;margin:0 0 14px}
    h1{font-size:68px;white-space:nowrap;line-height:1.1;margin:0;font-weight:900;letter-spacing:2px;text-shadow:0 6px 0 #1d4ed8,0 0 40px #0008}
    .sub{font-size:36px;white-space:nowrap;font-weight:800;color:#fde047;margin:30px 0 0;letter-spacing:2px}
    .note{margin-top:28px;display:inline-block;border:2px solid #ffffff55;border-radius:30px;padding:10px 22px;font-size:21px;letter-spacing:1px;color:#e8f0f8}
    .url{margin-top:26px;font-size:20px;color:#9fc2e6;letter-spacing:1px}
    .shot{position:absolute;width:270px;height:480px;border-radius:26px;border:6px solid #fff;overflow:hidden;box-shadow:0 24px 50px #0009;background:#000}
    .shot img{width:100%;height:100%;object-fit:cover;display:block}
    .a{left:660px;top:96px;transform:rotate(-5deg)}
    .b{left:900px;top:62px;transform:rotate(5deg)}
  </style>
  <div class="copy"><p class="brand">FIRST BASE UMPIRE</p><h1>一塁塁審ジャッジ</h1><p class="sub">足が先か、ボールが先か。</p><p class="note">際どい判定は、監督のリクエストでスロー検証</p><p class="url">game.chozo.net/umpire-1b</p></div>
  <div class="shot a"><img src="${img(live)}"></div>
  <div class="shot b"><img src="${img(split)}"></div>
  </html>`);
  await card.evaluate(() => document.fonts.ready);
  await card.waitForTimeout(200);
  await card.screenshot({ path: fileURLToPath(new URL('../../public/ogp.png', import.meta.url)) });
  console.log('Created public/ogp.png (1200 × 630)');
} finally {
  await browser.close();
}
