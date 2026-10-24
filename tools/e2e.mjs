// ブラウザでの通し確認（playwright-core + インストール済み Chrome）
// 使い方: npm run dev（別ターミナル）→ npm run e2e [URL]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.argv[2] ?? 'http://localhost:5289/';
const OUT = 'tools/out/e2e';
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=metal', '--enable-gpu', '--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

async function open(viewport, seed = 11) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${URL}?seed=${seed}`);
  await page.waitForFunction(() => window.__game);
  await page.evaluate(() => window.__game.manual(true));
  const g = (fn, arg) => page.evaluate(fn, arg);
  const step = (sec, dt = 1 / 60) => g(([s, d]) => window.__game.step(d, Math.max(1, Math.round(s / d))), [sec, dt]);
  const state = () => g(() => window.__game.state());
  const until = async (cond, max = 30, dt = 1 / 30) => {
    for (let i = 0; i < max / dt; i++) {
      const s = await state();
      if (cond(s)) return s;
      await step(dt, dt);
    }
    throw new Error('until: timeout ' + JSON.stringify(await state()));
  };
  return { page, errors, g, step, state, until };
}

// 1プレーを進める。how: 'correct' | 'wrong' | 'none'
async function playOne(t, how) {
  const s0 = await t.until((s) => s.phase === 'play' && s.armed);
  const truth = s0.play.out ? 'out' : 'safe';
  if (how === 'correct') await t.g((c) => window.__game.call(c), truth);
  if (how === 'wrong') await t.g((c) => window.__game.call(c), truth === 'out' ? 'safe' : 'out');
  const s1 = await t.until((s) => s.records.length > s0.records.length, 5);
  const rec = s1.records[s1.records.length - 1];
  const seen = { request: false, r2: false, r3: false };
  // 次のプレー・結果画面まで進める（リプレイは最後まで見る）
  for (let i = 0; i < 2000; i++) {
    const s = await t.state();
    if (s.phase === 'request') seen.request = true;
    if (s.phase === 'replay' && s.replaySub === 'r2') seen.r2 = true;
    if (s.phase === 'replay' && s.replaySub === 'r3') {
      seen.r3 = true;
      await t.g(() => window.__game.advance());
    }
    if ((s.phase === 'play' && s.index > s0.index) || s.phase === 'result') break;
    await t.step(1 / 20, 1 / 20);
  }
  return { rec, play: s0.play, seen };
}

// --- 1. 正しくコールし続けると続き、際どいプレーはリクエスト → リプレイになる ---
{
  const t = await open({ width: 405, height: 720 });
  await t.page.screenshot({ path: `${OUT}/title.png` });
  await t.page.click('#btn-start');
  let close = 0;
  let requests = 0;
  const fielders = new Set();
  let lefty = 0;
  for (let i = 0; i < 14; i++) {
    const { rec, play, seen } = await playOne(t, 'correct');
    if (!rec.correct) check(false, `第${i + 1}打者の正しいコールが不正解扱い`);
    if (i < 3 && Math.abs(play.margin) < 0.3) check(false, `練習のプレーが際どい (${play.margin})`);
    if (play.close) {
      close++;
      if (!seen.request || !seen.r2 || !seen.r3) check(false, `際どいプレーでリクエスト・リプレイが出ない ${JSON.stringify(seen)}`);
    }
    if (seen.request) requests++;
    fielders.add(play.fielder);
    if (play.hand === 'L') lefty++;
  }
  const s = await t.state();
  check(s.misses === 0 && s.phase === 'play', `14打者を正しくコールして続く（誤審 ${s.misses}）`);
  check(s.score > 14 * 100, `得点が入る（${s.score}）`);
  check(close >= 2, `際どいプレーが出る（${close}回）`);
  check(requests >= close, `リクエストが出る（${requests}回）`);
  check(fielders.size >= 3, `いろいろな野手が処理する（${[...fielders].join(',')}）`);
  // 14 回正解のあと 3 回誤審 → 正解 14 回なので「審判見習い」（10〜19）
  for (let i = 0; i < 3; i++) await playOne(t, 'wrong');
  await t.until((s) => s.phase === 'result', 5);
  const rank14 = await t.page.textContent('#res-rank');
  check(rank14 === '審判見習い', `正解 14 回の称号は「審判見習い」（${rank14}）`);
  check(t.errors.length === 0, `エラーなし ${t.errors.join(' / ')}`);
  await t.page.close();
}

// --- 2. 誤審3回で失格 → もう一度 → タイトルへ ---
{
  const t = await open({ width: 405, height: 720 }, 23);
  await t.page.click('#btn-start');
  for (let i = 0; i < 3; i++) {
    const { rec, seen } = await playOne(t, 'wrong');
    check(!rec.correct && rec.requested, `誤審 ${i + 1} 回目はリクエストされる`);
    check(seen.r3, `誤審 ${i + 1} 回目でリプレイの結果が出る`);
  }
  let s = await t.until((s) => s.phase === 'result', 5);
  check(s.phase === 'result', '誤審3回で結果画面');
  const rank0 = await t.page.textContent('#res-rank');
  check(rank0 === '草野球の審判', `正解 0 回の称号は「草野球の審判」（${rank0}）`);
  const resText = await t.page.textContent('#result');
  check(!resText.includes('連続') && (await t.page.locator('#streak').count()) === 0, '連続正解の表示と「最大連続」がない');
  await t.page.waitForTimeout(400);
  await t.page.screenshot({ path: `${OUT}/result.png` });
  await t.page.click('#btn-retry');
  s = await t.state();
  check(s.phase === 'play' && s.misses === 0 && s.score === 0, 'もう一度で最初から');
  // 時間切れ
  await t.until((s) => s.armed);
  await t.step(2.2, 1 / 30);
  s = await t.state();
  check(s.misses === 1 && s.records[0].call === null, '2秒以内にコールしないと誤審（時間切れ）');
  // 早すぎる入力は無視
  await t.until((s) => s.phase === 'play' && s.index === 1, 20);
  await t.until((s) => s.t > s.play.tHit + 0.5, 10);
  await t.g(() => window.__game.call('out'));
  s = await t.state();
  check(s.phase === 'play' && s.records.length === 1, '両方が起きる前のコールは無視');
  await t.g(() => window.__game.toTitle());
  check((await t.state()).phase === 'title', 'タイトルへ戻る');
  check(t.errors.length === 0, `エラーなし ${t.errors.join(' / ')}`);
  await t.page.close();
}

// --- 2b. ボタンの並び（左 = セーフ、右 = アウト）とキー（F = セーフ、J = アウト） ---
{
  const t = await open({ width: 405, height: 720 }, 31);
  await t.page.click('#btn-start');
  const safe = await t.page.locator('#btn-safe').boundingBox();
  const out = await t.page.locator('#btn-out').boundingBox();
  check(safe.x < out.x, `セーフのボタンが左、アウトが右（${Math.round(safe.x)} / ${Math.round(out.x)}）`);
  for (const [key, want] of [['f', 'safe'], ['j', 'out']]) {
    const s0 = await t.until((s) => s.phase === 'play' && s.armed);
    await t.page.keyboard.press(key);
    const s1 = await t.until((s) => s.records.length > s0.records.length, 5);
    const call = s1.records[s1.records.length - 1].call;
    check(call === want, `${key.toUpperCase()} キーで「${want === 'safe' ? 'セーフ' : 'アウト'}」（${call}）`);
    for (let i = 0; i < 2000; i++) {
      const s = await t.state();
      if (s.phase === 'replay' && s.replaySub === 'r3') await t.g(() => window.__game.advance());
      if ((s.phase === 'play' && s.index > s0.index) || s.phase === 'result') break;
      await t.step(1 / 20, 1 / 20);
    }
  }
  // リクエストの場面でタップすると、スローを見せずに結果だけを出す
  {
    const s0 = await t.until((s) => s.phase === 'play' && s.armed);
    await t.g((c) => window.__game.call(c), s0.play.out ? 'safe' : 'out'); // わざと誤審してリクエストを出す
    await t.until((s) => s.phase === 'request', 5);
    await t.step(0.5, 1 / 60);
    await t.page.keyboard.press('Space');
    const s1 = await t.state();
    const vis = await t.page.locator('#replay-result').isVisible();
    check(s1.phase === 'replay' && s1.replaySub === 'r3' && vis, `リクエストの場面からスキップすると結果だけが出る（${s1.phase} ${s1.replaySub}）`);
    await t.step(0.6, 1 / 60);
    await t.g(() => window.__game.advance());
  }
  // 得点: 正解 100 点・際どい正解 300 点、早押しボーナス（0.7 秒以内 +20、1.0 秒以内 +10）
  for (const [delay, want] of [[0.5, 20], [0.85, 10], [1.2, 0]]) {
    const s0 = await t.until((s) => s.phase === 'play' && s.armed);
    await t.step(delay, 1 / 60);
    await t.g((c) => window.__game.call(c), s0.play.out ? 'out' : 'safe');
    const s1 = await t.until((s) => s.records.length > s0.records.length, 5);
    const r = s1.records[s1.records.length - 1];
    const base = s0.play.close ? 300 : 100;
    check(r.correct && r.base === base && r.bonus === want && r.points === base + want,
      `${delay} 秒後に正しくコール → ${base} ＋ ${want}（${r.base} ＋ ${r.bonus} = ${r.points}）`);
    for (let i = 0; i < 2000; i++) {
      const s = await t.state();
      if (s.phase === 'verdict' && !s0.play.close) {
        const txt = await t.page.textContent('#verdict');
        check(txt.startsWith('正解') && (want ? txt.includes(`100 ＋ ${want}（早押しボーナス）`) : txt.endsWith('100')), `判定の表示が球審ジャッジと同じ書き方（${txt}）`);
        await t.g(() => window.__game.advance());
      }
      if (s.phase === 'replay' && s.replaySub === 'r3') {
        const txt = await t.page.textContent('#replay-result .judge');
        check(txt.startsWith('ナイスジャッジ！') && txt.includes(want ? `300 ＋ ${want}（早押しボーナス）` : '300'), `際どいプレーの正解の表示（${txt}）`);
        await t.g(() => window.__game.advance());
      }
      if ((s.phase === 'play' && s.index > s0.index) || s.phase === 'result') break;
      await t.step(1 / 20, 1 / 20);
    }
  }
  await t.page.close();
}

// --- 3. 見た目と正解が一致する（足・ミット・音） ---
{
  const t = await open({ width: 405, height: 720 }, 5);
  await t.page.click('#btn-start');
  for (const [m, f] of [
    [0.012, 'SS'],
    [-0.008, '3B'],
    [0.03, '2B'],
    [-0.02, 'P'],
  ]) {
    await t.g(([mm, ff]) => window.__game.replay({ margin: mm, fielder: ff }), [m, f]);
    const s = await t.state();
    const p = s.play;
    // ベースに触れる直前・瞬間
    const at = async (time) => {
      await t.step(time - (await t.state()).t, 1 / 240);
      return t.g(() => window.__game.probe());
    };
    const before = await at(p.tArrive - 0.02);
    const touch = await at(p.tArrive + 0.001);
    check(before.lAnkle[1] > 0.17, `${f}: 触れる 0.02 秒前は足がベースの上で浮いている（足首 ${before.lAnkle[1].toFixed(3)}m）`);
    check(Math.abs(touch.lAnkle[1] - 0.16) < 0.006, `${f}: 触れた瞬間は足がベースの上（足首 ${touch.lAnkle[1].toFixed(3)}m）`);
    const t0 = (await t.state()).t;
    const c = await at(p.tCatch + 0.001);
    const d = Math.hypot(c.glove[0] - c.ball[0], c.glove[1] - c.ball[1], c.glove[2] - c.ball[2]);
    check(d < 0.01, `${f}: 捕球の瞬間、ボールはグラブの位置（ずれ ${(d * 100).toFixed(1)}cm）`);
    const v = await t.g(() => window.__game.sight());
    check(
      !v.ball.by && v.ball.y > 0.2 && v.ball.y < 0.8 && v.ball.x > 0.15 && v.ball.x < 0.85,
      `${f}: 捕球の瞬間、ボールは体に隠れず画面の中ほどに映る（${v.ball.by ?? '隠れなし'}、x ${v.ball.x.toFixed(2)} y ${v.ball.y.toFixed(2)}、大きさ ${(v.ballSize * 100).toFixed(1)}%）`,
    );
    void t0;
    // 音の順番と間隔
    const all = await t.g(() => window.__game.audioLog());
    const log = all.filter((e) => e.name === 'touch' || e.name === 'mitt').slice(-2);
    const bag = log.find((e) => e.name === 'touch');
    const mitt = log.find((e) => e.name === 'mitt');
    const gap = bag.t - mitt.t;
    check(Math.abs(gap - p.margin) < 0.003, `${f}: ベースを踏む足音とミットの音の間隔が差と一致（${gap.toFixed(4)} / ${p.margin}）`);
    check(!all.some((e) => e.name === 'bag'), `${f}: プレー中にベースを踏む特別な音は鳴らない`);
  }
  check(t.errors.length === 0, `エラーなし ${t.errors.join(' / ')}`);
  await t.page.close();
}

// --- 4. 画面サイズ: 小さいスマホ・PC で切れない ---
for (const vp of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  const t = await open(vp, 9);
  const box = await t.g(() => {
    const a = document.getElementById('app').getBoundingClientRect();
    const c = document.getElementById('controls').getBoundingClientRect();
    const st = document.getElementById('btn-start').getBoundingClientRect();
    return { a: [a.left, a.top, a.right, a.bottom], c: [c.top, c.bottom], st: [st.top, st.bottom] };
  });
  check(box.a[1] >= 0 && box.a[3] <= vp.height + 1 && box.c[1] <= vp.height + 1, `${vp.width}x${vp.height}: 画面に収まる`);
  check(box.st[1] < box.c[0], `${vp.width}x${vp.height}: 開始ボタンが判定ボタンに重ならない`);
  await t.page.screenshot({ path: `${OUT}/title-${vp.width}x${vp.height}.png` });
  await t.page.click('#btn-start');
  await t.g(() => window.__game.replay({ margin: 0.01, fielder: 'SS' }));
  await t.until((s) => s.armed);
  await t.page.screenshot({ path: `${OUT}/play-${vp.width}x${vp.height}.png` });
  await t.g(() => window.__game.call('safe'));
  await t.until((s) => s.phase === 'replay' && s.replaySub === 'r3', 40, 1 / 20);
  await t.page.waitForTimeout(400);
  await t.page.screenshot({ path: `${OUT}/replay-${vp.width}x${vp.height}.png` });
  check(t.errors.length === 0, `${vp.width}x${vp.height}: エラーなし ${t.errors.join(' / ')}`);
  await t.page.close();
}

await browser.close();
console.log(failed ? `\n${failed} 件の失敗` : '\nすべて成功');
process.exit(failed ? 1 : 0);
