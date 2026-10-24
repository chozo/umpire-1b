import * as THREE from 'three';
import { Cast } from './actors';
import { Sfx, type SfxName } from './audio';
import { footCam, managerCam, mittCam, umpireCamAt, umpireSpots } from './camera';
import { CAMERA, GAME, SCORE, STAGE, levelOf, lineToWorld, type Vec3 } from './config';
import { ballAt, generatePlay, mulberry32, type Force, type Play } from './play';
import { BallView, Marker, Trail, buildStadium } from './scene';

type Call = 'out' | 'safe';
type Phase = 'title' | 'play' | 'called' | 'request' | 'replay' | 'verdict' | 'result';
type ReplaySub = 'r1' | 'r2' | 'r3';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- 描画の準備 ----
const canvas = $<HTMLCanvasElement>('c');
const view = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const { dugouts } = buildStadium(scene, renderer);
const cast = new Cast(scene, dugouts);
const ball = new BallView(scene);
const trail = new Trail(scene);
const markFoot = new Marker(scene, '#facc15');
const markBall = new Marker(scene, '#facc15');
const umpCam = new THREE.PerspectiveCamera(50, 1, 0.05, 600);
const camA = new THREE.PerspectiveCamera(34, 1, 0.03, 400); // リプレイ上（足）
const camB = new THREE.PerspectiveCamera(32, 1, 0.03, 400); // リプレイ下（ミット）
const mgrCam = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
let viewW = 1;
let viewH = 1;

function resize() {
  viewW = view.clientWidth;
  viewH = view.clientHeight;
  renderer.setSize(viewW, viewH, false);
  for (const c of [umpCam, mgrCam]) {
    c.aspect = viewW / viewH;
    c.updateProjectionMatrix();
  }
  for (const c of [camA, camB]) {
    c.aspect = viewW / (viewH / 2);
    c.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(view);
resize();

const sfx = new Sfx();

// ---- 状態 ----
const params = new URLSearchParams(location.search);
let rng = mulberry32(Number(params.get('seed')) || (Date.now() & 0xffffffff));

type Rec = {
  play: Play;
  call: Call | null;
  correct: boolean;
  requested: boolean;
  reaction: number; // 両方が起きてからコールまでの秒数
  base: number;
  bonus: number; // 早押しボーナス
  points: number;
};

type AudioEv = { t: number; name: SfxName; pos: Vec3; vol: number; done: boolean; rate?: number; touch?: boolean };

const S = {
  phase: 'title' as Phase,
  t: 0, // プレーの時刻（打つ瞬間が GAME.tHit）
  pt: 0, // フェーズ内の経過時間
  index: 0,
  score: 0,
  misses: 0,
  play: null as Play | null,
  call: null as Call | null,
  armed: false,
  armedAt: 0,
  requestSide: null as 'home' | 'away' | null,
  replaySub: 'r1' as ReplaySub,
  rt: 0, // リプレイで映しているプレーの時刻
  pause: 0,
  shown: { foot: false, ball: false },
  records: [] as Rec[],
  timeScale: 1,
  forced: null as Force | null,
  events: [] as string[],
  audioEvs: [] as AudioEv[],
  handL: [] as THREE.Vector3[],
  handR: [] as THREE.Vector3[],
  verdictShown: false,
};
let spots: ReturnType<typeof umpireSpots> | null = null;
const audioLog: { name: SfxName | 'touch'; t: number }[] = [];

const BEST_KEY = 'umpire1b.best';
function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}
function saveBest(v: number) {
  try {
    localStorage.setItem(BEST_KEY, String(v));
  } catch {
    // 保存できない環境では記録しない
  }
}

// ---- UI ----
const ui = {
  hud: $('hud'),
  count: $('hud-count'),
  score: $('hud-score'),
  miss: $('hud-miss'),
  timer: $('timer'),
  timerBar: $('timer-bar'),
  hint: $('hint'),
  call: $('call'),
  verdict: $('verdict'),
  request: $('request'),
  requestSub: $('request-sub'),
  replayTag: $('replay-tag'),
  replayTagSub: $('replay-tag-sub'),
  split: $('split'),
  stampFoot: $('stamp-foot'),
  stampBall: $('stamp-ball'),
  clock: $('clock'),
  replayResult: $('replay-result'),
  title: $('title'),
  result: $('result'),
  btnOut: $('btn-out'),
  btnSafe: $('btn-safe'),
};

function renderHud() {
  ui.count.textContent = String(S.index + 1);
  ui.score.textContent = S.score.toLocaleString();
  ui.miss.innerHTML = Array.from({ length: GAME.maxMisses }, (_, i) => `<i class="${i < S.misses ? 'on' : ''}"></i>`).join('');
}

let hintTimer = 0;
function showHint(text: string, sec = 0.9) {
  ui.hint.textContent = text;
  ui.hint.hidden = false;
  hintTimer = sec;
}

function setButtonsArmed(on: boolean) {
  ui.btnOut.classList.toggle('idle', !on);
  ui.btnSafe.classList.toggle('idle', !on);
}

function clearOverlays() {
  ui.call.hidden = true;
  ui.verdict.hidden = true;
  ui.request.hidden = true;
  ui.replayTag.hidden = true;
  ui.split.hidden = true;
  ui.replayResult.hidden = true;
  ui.timer.hidden = true;
  ui.stampFoot.hidden = true;
  ui.stampBall.hidden = true;
}

function setPhase(p: Phase) {
  S.phase = p;
  S.pt = 0;
  S.events.push('phase:' + p);
  if (S.events.length > 500) S.events.splice(0, S.events.length - 200);
}

// ---- 進行 ----
function startGame() {
  sfx.unlock();
  sfx.startBgm();
  S.index = 0;
  S.score = 0;
  S.misses = 0;
  S.records = [];
  ui.title.hidden = true;
  ui.result.hidden = true;
  ui.hud.hidden = false;
  nextPlay();
  showHint('足とボール、どっちが先？', 2.6);
}

function nextPlay() {
  clearOverlays();
  ui.hud.hidden = false;
  trail.clear();
  cast.endRequest();
  const forced = S.forced;
  S.forced = null;
  // 練習の2プレー目は1プレー目と逆（アウトとセーフの両方を見せる）
  const prev = S.records[S.records.length - 1];
  const tut: Force = S.index > 0 && S.index < STAGE.tutorial && prev && !forced ? { out: !prev.play.out } : {};
  const correctSoFar = S.records.filter((r) => r.correct).length;
  const p = generatePlay(rng, S.index, { ...tut, ...(forced ?? {}) }, correctSoFar);
  S.play = p;
  spots = umpireSpots(p);
  S.call = null;
  S.armed = false;
  S.t = -0.6;
  S.requestSide = null;
  S.verdictShown = false;
  S.audioEvs = buildAudio(p);
  renderHud();
  setButtonsArmed(false);
  sfx.duck(true);
  sfx.setBgmSlow(false);
  setPhase('play');
}

// プレー中に鳴らす音（時刻・場所・大きさ）
function buildAudio(p: Play): AudioEv[] {
  const ev: AudioEv[] = [];
  ev.push({ t: p.tHit, name: 'bat', pos: p.ground.H, vol: 22, done: false });
  ev.push({ t: p.ground.tField, name: 'glove', pos: p.ground.G, vol: 9, done: false });
  ev.push({ t: p.tCatch, name: 'mitt', pos: p.th.C, vol: 6.5, done: false });
  ev.push({ t: p.tCatch - 0.28, name: 'whoosh', pos: p.th.C, vol: 1, done: false });
  p.runner.plants.forEach((pl, k) => {
    const pos = lineToWorld(pl.s, pl.l, 0);
    // ベースを踏む一歩も、ほかの足音と同じ音・大きさにする（音で捕球との前後が分からないように）
    ev.push({ t: pl.t, name: 'step', pos, vol: 3.2, done: false, touch: k === p.runner.touchIndex });
  });
  return ev.sort((a, b) => a.t - b.t);
}

// 先読みして予約する。rate < 1 はスロー再生
function scheduleAudio(fromT: number, toT: number, speed: number, rate = 1, only?: SfxName[]) {
  const cam = umpCam;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  for (const e of S.audioEvs) {
    if (e.done || e.t > toT) continue;
    if (only && !only.includes(e.name)) {
      if (e.t <= fromT) e.done = true;
      continue;
    }
    e.done = true;
    if (e.t < fromT - 0.05) continue; // 取りこぼし（タブが止まっていたなど）は鳴らさない
    const d = Math.max(1, cam.position.distanceTo(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z)));
    const vol = Math.min(1.1, e.vol / d);
    const rel = new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z).sub(cam.position).normalize();
    const pan = Math.max(-0.8, Math.min(0.8, rel.dot(right) * 0.9));
    const delay = Math.max(0, (e.t - fromT) / Math.max(1e-3, speed));
    // 確認用: 鳴らす予定のプレー時刻
    audioLog.push({ name: e.touch ? 'touch' : e.name, t: fromT + delay * speed });
    if (audioLog.length > 300) audioLog.splice(0, 100);
    if (e.name === 'whoosh') sfx.play('whoosh', [0.28 / speed, 0.1], delay);
    else sfx.play(e.name, [vol, pan, rate], delay);
  }
}

function onCall(c: Call) {
  if (S.phase === 'replay' || S.phase === 'request') {
    skipReplay();
    return;
  }
  if (S.phase === 'verdict' && S.pt > 0.6) {
    advance();
    return;
  }
  if (S.phase !== 'play' || !S.play || S.call) return;
  if (!S.armed) {
    if (S.t > S.play.tHit) showHint('まだ早い！ 両方を見てから');
    return;
  }
  S.call = c;
  pressFx(c);
  resolve();
}

function pressFx(c: Call) {
  const b = c === 'out' ? ui.btnOut : ui.btnSafe;
  b.classList.add('pressed');
  setTimeout(() => b.classList.remove('pressed'), 120);
}

function truthOf(p: Play): Call {
  return p.out ? 'out' : 'safe';
}

function resolve() {
  const p = S.play!;
  setButtonsArmed(false);
  ui.timer.hidden = true;
  const correct = S.call === truthOf(p);
  // リクエスト: 誤審と際どい判定のときだけ（際どいプレーの割合は config.ts の LEVELS）
  const requested = !!S.call && (!correct || p.close);
  S.requestSide = requested ? (S.call === 'out' ? 'away' : 'home') : null;
  const reaction = S.t - S.armedAt;
  let base = 0;
  let bonus = 0;
  if (correct) {
    base = p.close ? SCORE.closeCorrect : SCORE.correct;
    bonus = SCORE.speedBonus.find((b) => reaction <= b.within)?.points ?? 0;
  } else {
    S.misses++;
  }
  const points = base + bonus;
  S.records.push({ play: p, call: S.call, correct, requested, reaction, base, bonus, points });
  S.events.push(`resolve:${S.call ?? 'none'}:${truthOf(p)}:${correct ? 'ok' : 'ng'}:${requested ? 'req' : '-'}`);
  ui.call.hidden = false;
  ui.call.className = S.call ?? 'late';
  ui.call.textContent = S.call === 'out' ? 'アウト！' : S.call === 'safe' ? 'セーフ！' : '判定遅れ…';
  if (S.call) {
    sfx.play('call', [S.call]);
    sfx.play('crowd', [S.call === 'out' ? 'cheer' : 'ooh', 1.6, 0.22], 0.1);
  } else sfx.play('wrong');
  setPhase('called');
}

function lastRec() {
  return S.records[S.records.length - 1];
}

// 得点の内訳（「球審ジャッジ」と同じ書き方）
function pointsText(r: Rec) {
  return r.bonus > 0 ? `${r.base} ＋ ${r.bonus}（早押しボーナス）` : `${r.base}`;
}

// リクエストなし: すぐに正誤を出す
function showVerdict() {
  const r = lastRec();
  ui.call.hidden = true;
  ui.verdict.hidden = false;
  if (r.correct) {
    const big = r.play.close;
    ui.verdict.className = 'ok' + (big ? ' big' : '');
    ui.verdict.innerHTML = (big ? 'ナイスジャッジ！' : '正解') + `<small>${pointsText(r)}</small>`;
    sfx.play('correct', [big]);
    S.score += r.points;
  } else {
    ui.verdict.className = 'ng';
    ui.verdict.innerHTML = r.call ? '誤審…' : '時間切れ';
    sfx.play('wrong');
  }
  renderHud();
  setPhase('verdict');
}

function startRequest() {
  clearOverlays();
  const side = S.requestSide!;
  ui.request.hidden = false;
  ui.requestSub.className = 'req-sub ' + side;
  ui.requestSub.textContent = side === 'away' ? '攻撃側の監督が「セーフでは？」' : '守備側の監督が「アウトでは？」';
  sfx.play('chime');
  sfx.play('crowd', ['ooh', 2.2, 0.28], 0.2);
  S.handL = [];
  S.handR = [];
  trail.clear();
  trail.setOpacity(1);
  setPhase('request');
}

function startReplay() {
  clearOverlays();
  trail.clear();
  cast.endRequest();
  ui.replayTag.hidden = false;
  ui.replayTagSub.textContent = 'リプレイ検証中';
  replaySkipHint(true);
  ui.hud.hidden = true;
  sfx.setBgmSlow(true);
  sfx.play('swoosh');
  const p = S.play!;
  S.replaySub = 'r1';
  S.rt = Math.min(p.tCatch, p.tArrive) - 0.75;
  S.shown = { foot: false, ball: false };
  S.pause = 0;
  // 音をもう一度鳴らせるようにする
  for (const e of S.audioEvs) e.done = e.t < S.rt;
  setPhase('replay');
}

const FIRST = () => Math.min(S.play!.tCatch, S.play!.tArrive);
const LAST = () => Math.max(S.play!.tCatch, S.play!.tArrive);

function startSplit() {
  const p = S.play!;
  markFoot.hide();
  markBall.hide();
  S.replaySub = 'r2';
  S.rt = FIRST() - 0.2;
  S.shown = { foot: false, ball: false };
  S.pause = 0.5;
  for (const e of S.audioEvs) e.done = e.t < S.rt;
  ui.split.hidden = false;
  ui.stampFoot.hidden = true;
  ui.stampBall.hidden = true;
  ui.replayTagSub.textContent = 'スーパースロー';
  footCam(p, camA);
  mittCam(p, camB);
  sfx.play('swoosh');
}

function fmt(sec: number) {
  return (sec >= 0 ? '+' : '−') + Math.abs(sec).toFixed(3);
}

// 左上の「タップで結果へ」。結果を出したら消す（結果の「タップで次へ」と食い違わないように）
function replaySkipHint(on: boolean) {
  const el = ui.replayTag.querySelector<HTMLElement>('.skip');
  if (el) el.style.display = on ? '' : 'none';
}

function showReplayResult() {
  const p = S.play!;
  const r = lastRec();
  S.replaySub = 'r3';
  replaySkipHint(false);
  S.pt = 0;
  const truth = truthOf(p);
  const ms = Math.abs(p.margin);
  const who = p.out ? 'ボール' : '足';
  ui.replayResult.hidden = false;
  ui.replayResult.innerHTML =
    `<span class="res ${truth}">${truth === 'out' ? 'アウト' : 'セーフ'}</span>` +
    `<span class="diff">${who}が <b>${ms.toFixed(3)}秒</b> 先</span><br>` +
    (r.correct
      ? `<span class="judge ok${p.close ? ' big' : ''}">${p.close ? 'ナイスジャッジ！' : '正解'}<small>${pointsText(r)}</small></span>`
      : `<span class="judge ng">誤審…<small>判定がくつがえった</small></span>`) +
    `<span class="next">タップで次へ</span>`;
  if (r.correct) {
    sfx.play('correct', [p.close]);
    sfx.play('crowd', ['cheer', 1.4, 0.2]);
    S.score += r.points;
  } else {
    sfx.play('wrong');
    sfx.play('crowd', ['boo', 1.8, 0.25]);
  }
  renderHud();
  S.events.push('replayResult');
}

// タップでリプレイを飛ばす。監督のリクエストの場面からでも、スローを見せずに結果だけを出す
function skipReplay() {
  if (S.phase === 'request') {
    if (S.pt < GAME.replaySkipGuard) return;
    startReplay();
    jumpToResult();
    return;
  }
  if (S.phase !== 'replay') return;
  if (S.replaySub === 'r3') {
    if (S.pt > 0.5) advance();
    return;
  }
  if (S.pt < GAME.replaySkipGuard) return;
  jumpToResult();
}

// 結果へ（分割画面の最後の場面で止め、足とミットの印と時刻を出す）
function jumpToResult() {
  if (S.replaySub === 'r1') startSplit();
  S.rt = LAST() + 0.12;
  S.pause = 0;
  S.shown = { foot: true, ball: true };
  const p = S.play!;
  const tp = p.runner.plants[p.runner.touchIndex];
  markFoot.show(lineToWorld(tp.s, tp.l, 0.12), 0.42);
  markBall.show(p.th.C, 0.3);
  showStamps();
  showReplayResult();
}

function showStamps() {
  const p = S.play!;
  const first = FIRST();
  ui.stampFoot.hidden = !S.shown.foot;
  ui.stampBall.hidden = !S.shown.ball;
  ui.stampFoot.innerHTML = `ベースに触れた<small>${fmt(p.tArrive - first)}秒</small>`;
  ui.stampBall.innerHTML = `ミットに収まった<small>${fmt(p.tCatch - first)}秒</small>`;
}

function advance() {
  sfx.setBgmSlow(false);
  if (S.misses >= GAME.maxMisses) {
    showResult();
    return;
  }
  S.index++;
  nextPlay();
  const msg = stageMessage(S.index);
  if (msg) showHint(msg, 2.4);
}

function stageMessage(i: number) {
  if (i === STAGE.tutorial) return 'ここから本番！ 際どいタイミングも来るぞ';
  if (i === STAGE.lefty) return '左打者も登場！ 一塁に近いぶん速い';
  if (i === STAGE.wideThrow) return '送球がそれることも！ ミットをよく見よう';
  return null;
}

// 称号: 正しく判定できたプレーの数（config.ts の LEVELS。基準は「球審ジャッジ」と同じ）
function rankTitle(ok: number) {
  return levelOf(ok).title;
}

function showResult() {
  clearOverlays();
  setButtonsArmed(false);
  const n = S.records.length;
  const ok = S.records.filter((r) => r.correct).length;
  const close = S.records.filter((r) => r.play.close);
  const closeOk = close.filter((r) => r.correct).length;
  const best = loadBest();
  const isBest = S.score > best;
  if (isBest) saveBest(S.score);
  $('res-rank').textContent = rankTitle(ok);
  $('res-score').textContent = S.score.toLocaleString();
  $('res-correct').textContent = `${ok}回（${n}回中）`;
  $('res-close').textContent = `${closeOk} / ${close.length}回`;
  $('res-best').textContent = isBest ? '新記録！' : best > 0 ? `${best.toLocaleString()}点` : '―';
  $('res-best').classList.toggle('new', isBest);
  ui.hud.hidden = true;
  ui.result.hidden = false;
  sfx.duck(false);
  sfx.stopBgm(0.4);
  sfx.play('ejected');
  setPhase('result');
}

function toTitle() {
  sfx.stopBgm();
  ui.result.hidden = true;
  ui.title.hidden = false;
  ui.hud.hidden = true;
  setPhase('title');
}

// ---- 描画するもの ----
type View = 'ump' | 'mgr' | 'split';
let viewMode: View = 'ump';
const tmpV = new THREE.Vector3();

function placeWorld(p: Play, t: number) {
  cast.update(p, t);
  if (cast.heldBall(p, t, tmpV)) ball.mesh.position.copy(tmpV);
  else {
    const b = ballAt(p, t).pos;
    ball.mesh.position.set(b.x, b.y, b.z);
  }
}

// タイトル画面の背景に流すプレー
let demo: Play | null = null;
let demoT = 0;

function update(dt: number) {
  S.pt += dt;
  if (hintTimer > 0) {
    hintTimer -= dt;
    if (hintTimer <= 0) ui.hint.hidden = true;
  }
  const p = S.play;
  switch (S.phase) {
    case 'title':
    case 'result': {
      if (!demo || demoT > demo.tArrive + 2.5) {
        demo = generatePlay(mulberry32((Math.random() * 1e9) | 0), 12);
        demoT = demo.tHit - 1.2;
      }
      demoT += dt;
      placeWorld(demo, demoT);
      umpireCamAt(demo, demoT, umpCam);
      viewMode = 'ump';
      break;
    }
    case 'play': {
      if (!p) break;
      const t0 = S.t;
      S.t += dt;
      placeWorld(p, S.t);
      umpireCamAt(p, S.t, umpCam, spots!);
      viewMode = 'ump';
      scheduleAudio(t0, S.t + 0.1 * Math.max(1, S.timeScale), S.timeScale);
      if (!S.armed && S.t >= LAST()) {
        S.armed = true;
        S.armedAt = S.t;
        setButtonsArmed(true);
        ui.timer.hidden = false;
        S.events.push('armed');
      }
      if (S.armed) {
        const left = 1 - (S.t - S.armedAt) / GAME.decisionWindow;
        ui.timerBar.style.transform = `scaleX(${Math.max(0, left)})`;
        if (left <= 0) {
          S.call = null;
          resolve();
        }
      }
      break;
    }
    case 'called': {
      if (!p) break;
      S.t += dt;
      placeWorld(p, S.t);
      umpireCamAt(p, S.t, umpCam, spots!);
      if (S.pt >= GAME.callDisplay) {
        sfx.duck(false);
        if (S.requestSide) startRequest();
        else showVerdict();
      }
      break;
    }
    case 'request': {
      if (!p) break;
      placeWorld(p, S.t);
      const side = S.requestSide!;
      const h = cast.managerRequest(side, S.pt);
      managerCam(dugouts[side], S.pt, mgrCam);
      viewMode = 'mgr';
      if (S.pt >= 1.27 && S.pt <= 2.2) {
        S.handL.push(h.l);
        S.handR.push(h.r);
        trail.set(S.handL, S.handR);
      }
      if (S.pt > 2.6) trail.setOpacity(Math.max(0, 1 - (S.pt - 2.6) / 0.4));
      if (S.pt >= 3.1) startReplay();
      break;
    }
    case 'replay': {
      if (!p) break;
      if (S.replaySub === 'r1') {
        // 塁審の目線でスロー（0.4倍）
        const sp = 0.4;
        const t0 = S.rt;
        S.rt += dt * sp;
        placeWorld(p, S.rt);
        umpireCamAt(p, S.rt, umpCam, spots!);
        viewMode = 'ump';
        scheduleAudio(t0, S.rt + 0.05, sp, 0.7, ['step', 'mitt']);
        if (S.rt >= LAST() + 0.15) startSplit();
      } else if (S.replaySub === 'r2') {
        viewMode = 'split';
        if (S.pause > 0) S.pause -= dt;
        else {
          const near = Math.min(Math.abs(S.rt - p.tArrive), Math.abs(S.rt - p.tCatch));
          const sp = near < 0.05 ? 1 / 30 : near < 0.14 ? 1 / 10 : 1 / 4;
          let next = S.rt + dt * sp;
          // 出来事の瞬間で止める
          const evs: ['foot' | 'ball', number][] = [
            ['foot', p.tArrive],
            ['ball', p.tCatch],
          ];
          evs.sort((a, b) => a[1] - b[1]);
          for (const [k, te] of evs) {
            if (!S.shown[k] && S.rt < te && next >= te) {
              next = te;
              S.shown[k] = true;
              S.pause = 0.8;
              showStamps();
              if (k === 'foot') {
                const tp = p.runner.plants[p.runner.touchIndex];
                markFoot.show(lineToWorld(tp.s, tp.l, 0.12), 0.42);
              } else markBall.show(p.th.C, 0.3);
              sfx.play(k === 'foot' ? 'bag' : 'mitt', [0.9, 0, 0.45]);
              S.events.push('stamp:' + k);
              break;
            }
          }
          S.rt = next;
          if (S.rt >= LAST() + 0.12) showReplayResult();
        }
        placeWorld(p, S.rt);
        ui.clock.textContent = fmt(S.rt - FIRST());
      } else {
        viewMode = 'split';
        placeWorld(p, S.rt);
        if (S.pt > 4.5) advance();
      }
      break;
    }
    case 'verdict': {
      if (!p) break;
      S.t += dt;
      placeWorld(p, S.t);
      umpireCamAt(p, S.t, umpCam, spots!);
      if (S.pt >= GAME.resultDisplay) advance();
      break;
    }
  }
  if (S.phase !== 'request') cast.managerIdle();
  if (S.phase !== 'replay') {
    markFoot.hide();
    markBall.hide();
  }
  markFoot.tick(dt);
  markBall.tick(dt);
}

function render() {
  if (viewMode === 'split') {
    renderer.setScissorTest(true);
    const h2 = viewH / 2;
    // 上: 足とベース
    ball.place(ball.mesh.position, camA, false);
    renderer.setViewport(0, h2, viewW, h2);
    renderer.setScissor(0, h2, viewW, h2);
    renderer.render(scene, camA);
    // 下: ミット
    renderer.setViewport(0, 0, viewW, h2);
    renderer.setScissor(0, 0, viewW, h2);
    renderer.render(scene, camB);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewW, viewH);
  } else {
    const cam = viewMode === 'mgr' ? mgrCam : umpCam;
    ball.place(ball.mesh.position, cam, viewMode === 'ump');
    renderer.render(scene, cam);
  }
}

// ---- 入力 ----
ui.btnOut.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onCall('out');
});
ui.btnSafe.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  onCall('safe');
});
view.addEventListener('pointerdown', () => {
  if (S.phase === 'replay' || S.phase === 'request') skipReplay();
  else if (S.phase === 'verdict' && S.pt > 0.6) advance();
});
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  // ボタンの並び（左 = セーフ、右 = アウト）に合わせる
  if (k === 'f' || e.key === 'ArrowLeft') onCall('safe');
  else if (k === 'j' || e.key === 'ArrowRight') onCall('out');
  else if ((k === ' ' || k === 'enter') && (S.phase === 'title' || S.phase === 'result')) startGame();
  else if ((k === ' ' || k === 'enter') && (S.phase === 'replay' || S.phase === 'request')) skipReplay();
  else if (k === 'm') setBgm(!sfx.bgmOn);
});
$('btn-start').addEventListener('click', startGame);
$('btn-retry').addEventListener('click', startGame);
$('btn-title').addEventListener('click', toTitle);

const BGM_KEY = 'umpire1b.bgm';
function setBgm(on: boolean) {
  sfx.setBgmOn(on);
  try {
    localStorage.setItem(BGM_KEY, on ? '1' : '0');
  } catch {
    // 保存できない環境では今回だけ
  }
  document.querySelectorAll<HTMLButtonElement>('.bgm-toggle').forEach((b) => {
    b.textContent = on ? 'BGM オン' : 'BGM オフ';
    b.classList.toggle('off', !on);
  });
}
try {
  setBgm(localStorage.getItem(BGM_KEY) !== '0');
} catch {
  setBgm(true);
}
document.querySelectorAll<HTMLButtonElement>('.bgm-toggle').forEach((b) =>
  b.addEventListener('click', () => {
    sfx.unlock();
    setBgm(!sfx.bgmOn);
  }),
);
document.addEventListener('visibilitychange', () => sfx.suspend(document.hidden));

// ---- ループ ----
let last = performance.now();
let manual = false;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!manual) {
    update(dt * S.timeScale);
    render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- 確認用の入口 ----
declare global {
  interface Window {
    __game: unknown;
  }
}
window.__game = {
  state: () => ({
    phase: S.phase,
    replaySub: S.replaySub,
    t: S.t,
    rt: S.rt,
    index: S.index,
    score: S.score,
    misses: S.misses,
    armed: S.armed,
    requestSide: S.requestSide,
    view: viewMode,
    play: S.play && {
      out: S.play.out,
      margin: S.play.margin,
      close: S.play.close,
      category: S.play.category,
      fielder: S.play.fielder,
      kind: S.play.fp.kind,
      hand: S.play.runner.hand,
      tHit: S.play.tHit,
      tField: S.play.ground.tField,
      tRelease: S.play.th.tRelease,
      tCatch: S.play.tCatch,
      tArrive: S.play.tArrive,
    },
    records: S.records.map((r) => ({ call: r.call, correct: r.correct, requested: r.requested, reaction: r.reaction, base: r.base, bonus: r.bonus, points: r.points })),
  }),
  start: startGame,
  call: onCall,
  skip: skipReplay,
  advance,
  toTitle,
  setTimeScale: (s: number) => (S.timeScale = s),
  setSeed: (n: number) => (rng = mulberry32(n)),
  force: (f: Force | null) => (S.forced = f),
  replay: (f: Force | null) => {
    S.forced = f;
    nextPlay();
  },
  manual: (on: boolean) => (manual = on),
  camera: CAMERA, // 見た目の確認用: 塁審の目線の調整値（次のプレーから効く）
  step: (dt: number, n = 1) => {
    for (let i = 0; i < n; i++) update(dt);
    render();
  },
  drainEvents: () =>
    S.events.splice(0).map((e) => {
      const [type, ...args] = e.split(':');
      return { type, args };
    }),
  // 検算: いま描いている足とグラブの位置
  probe: () => {
    const f = cast.batter.j;
    const g = cast.firstBase.j.lHand;
    return {
      lAnkle: f.lAnkle.toArray(),
      rAnkle: f.rAnkle.toArray(),
      glove: g.toArray(),
      ball: ball.mesh.position.toArray(),
      cam: umpCam.position.toArray(),
    };
  },
  // 検算: 塁審の目線から、ミットとボールが走者・一塁手の体に隠れていないか。画面での位置（0..1、上が0）
  sight: () => {
    const from = umpCam.position;
    const glove = cast.firstBase.glove!;
    const inside = (o: THREE.Object3D, root: THREE.Object3D) => {
      for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q === root) return true;
      return false;
    };
    const ray = new THREE.Raycaster();
    const check = (target: THREE.Vector3) => {
      const d = target.clone().sub(from);
      const dist = d.length();
      ray.set(from, d.normalize());
      const hit = ray
        .intersectObjects([cast.batter.group, cast.firstBase.group], true)
        .find((h) => h.distance < dist - 0.06 && !inside(h.object, glove));
      const s = target.clone().project(umpCam);
      return {
        by: hit ? (inside(hit.object, cast.batter.group) ? 'runner' : 'firstBase') : null,
        x: (s.x + 1) / 2,
        y: (1 - s.y) / 2,
      };
    };
    const gp = new THREE.Vector3();
    glove.getWorldPosition(gp);
    // 走者の関節のうち、画面でボールにいちばん近いものまでの距離と、ボールの見かけの大きさ（どちらも画面の高さの割合）
    const bs = ball.mesh.position.clone().project(umpCam);
    let runnerGap = Infinity;
    for (const v of Object.values(cast.batter.j)) {
      const s = v.clone().project(umpCam);
      runnerGap = Math.min(runnerGap, Math.hypot(((s.x - bs.x) * viewW) / viewH, s.y - bs.y) / 2);
    }
    const ballSize = 0.073 / (ball.mesh.position.distanceTo(from) * 2 * Math.tan((umpCam.fov * Math.PI) / 360));
    // 走者の関節のうち、一塁手の体に隠れている割合（0..1）と、ベースを踏む足（左足首）が隠れているか
    const hiddenBy = (v: THREE.Vector3) => {
      const d = v.clone().sub(from);
      const dist = d.length();
      ray.set(from, d.normalize());
      return ray.intersectObject(cast.firstBase.group, true).some((h) => h.distance < dist - 0.06);
    };
    const joints = Object.values(cast.batter.j);
    const runnerHidden = joints.filter(hiddenBy).length / joints.length;
    const footHidden = hiddenBy(cast.batter.j.lAnkle);
    return { glove: check(gp), ball: check(ball.mesh.position.clone()), runnerGap, ballSize, runnerHidden, footHidden };
  },
  // 見た目の確認用: いまの場面を、指定した位置のカメラから1コマ描く（次の step で元の目線に戻る）
  peek: (from: [number, number, number], to: [number, number, number], fov = 50) => {
    const c = new THREE.PerspectiveCamera(fov, viewW / viewH, 0.05, 600);
    c.position.set(...from);
    c.lookAt(...to);
    ball.place(ball.mesh.position, c, false);
    renderer.render(scene, c);
  },
  audio: sfx, // capture / drain / render は告知動画の撮影用
  audioLog: () => audioLog.slice(),
};
