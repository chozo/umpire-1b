// 1プレーの「正解」を決める。画面の動き・音・リプレイはすべてここで作った時刻と位置から作る。
// 判定: 走者の足がベースに触れた時刻 tArrive と、送球がミットに収まった時刻 tCatch の差
//   margin = tArrive - tCatch。正ならボールが先（アウト）、負なら足が先（セーフ）。同時にはしない。

import {
  BAG_CENTER,
  BAG_HEIGHT,
  FIELDERS,
  GAME,
  MOUND_HEIGHT,
  RUNNER,
  STAGE,
  difficulty,
  lineToWorld,
  type FielderId,
  type Vec3,
} from './config';

// 投手のリリース位置（actors.ts の投球フォームと合わせる）
export const PITCHER_BASE: Vec3 = { x: 0, y: MOUND_HEIGHT, z: -18.29 };
export const PITCH_RELEASE: Vec3 = { x: -0.35, y: MOUND_HEIGHT + 1.62, z: -18.29 + 1.25 };

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;
const range = (rng: Rng, [a, b]: [number, number]) => a + (b - a) * rng();
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (u: number) => {
  const k = clamp(u, 0, 1);
  return k * k * (3 - 2 * k);
};

// ---- 走者 ----

export type Plant = {
  s: number; // 足の中心（一塁線に沿った距離）
  l: number; // 足の中心（フェア側への距離）
  y: number; // 足首の高さ（ベースの上なら高い）
  foot: 'L' | 'R';
  len: number; // この一歩の歩幅
  bodyS: number; // 着地の瞬間の腰の位置
  liftS: number; // 足が離れるときの腰の位置
  t: number; // 着地の時刻
  onBag: boolean;
};

export type RunnerPlan = {
  hand: 'R' | 'L';
  V: number;
  tau: number;
  s0: number;
  l0: number;
  tStart: number;
  sTouch: number; // ベースを踏む瞬間の腰の位置
  tArrive: number;
  vArrive: number;
  sStop: number;
  plants: Plant[];
  touchIndex: number;
  stance: { L: { s: number; l: number }; R: { s: number; l: number } };
};

export const ANKLE_H = 0.08;
const FOOT_HALF_W = 0.11;

function accelS(r: { V: number; tau: number }, tau: number) {
  if (tau <= 0) return 0;
  return r.V * (tau - r.tau * (1 - Math.exp(-tau / r.tau)));
}

// 腰の位置（一塁線に沿った距離）
export function runnerS(r: RunnerPlan, t: number) {
  if (t <= r.tStart) return r.s0;
  if (t <= r.tArrive) return r.s0 + accelS(r, t - r.tStart);
  const dt = t - r.tArrive;
  const tStop = r.vArrive / RUNNER.stopDecel;
  const d = Math.min(dt, tStop);
  return r.sTouch + r.vArrive * d - 0.5 * RUNNER.stopDecel * d * d;
}

// 腰が s に来る時刻
export function runnerTimeAtS(r: RunnerPlan, s: number) {
  if (s <= r.s0) return r.tStart;
  if (s <= r.sTouch) {
    let lo = 0;
    let hi = 12;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (r.s0 + accelS(r, mid) < s) lo = mid;
      else hi = mid;
    }
    return r.tStart + (lo + hi) / 2;
  }
  const ds = Math.min(s, r.sStop) - r.sTouch;
  const D = RUNNER.stopDecel;
  // ds = v dt - D/2 dt^2
  const disc = Math.max(0, r.vArrive * r.vArrive - 2 * D * ds);
  return r.tArrive + (r.vArrive - Math.sqrt(disc)) / D;
}

// 腰の横位置
export function runnerL(r: RunnerPlan, s: number) {
  const lane = RUNNER.laneL;
  const touchBody = RUNNER.touchFootL - FOOT_HALF_W;
  if (s < r.s0 + 6) return r.l0 + (lane - r.l0) * smooth((s - r.s0) / 6);
  if (s < r.sTouch) return lane + (touchBody - lane) * smooth((s - (r.sTouch - 5)) / 5);
  return touchBody + (-0.9 - touchBody) * smooth((s - r.sTouch) / 7);
}

function stepLen(d: number) {
  return 0.9 + 1.2 * clamp(d / 11, 0, 1);
}

export function makeRunner(hand: 'R' | 'L', V: number, tHit: number): RunnerPlan {
  // 打席の位置（右打者は三塁側、左打者は一塁側）
  const start = hand === 'R' ? { x: -0.62, z: 0.12 } : { x: 0.62, z: -0.12 };
  const s0 = start.x * Math.SQRT1_2 - start.z * Math.SQRT1_2;
  const l0 = -start.x * Math.SQRT1_2 - start.z * Math.SQRT1_2;
  const r: RunnerPlan = {
    hand,
    V,
    tau: RUNNER.accelTau,
    s0,
    l0,
    tStart: tHit + RUNNER.startDelay + (hand === 'L' ? -0.05 : 0),
    sTouch: 0,
    tArrive: 0,
    vArrive: 0,
    sStop: 0,
    plants: [],
    touchIndex: 0,
    stance: { L: { s: 0, l: 0 }, R: { s: 0, l: 0 } },
  };
  // ベースを踏む一歩から逆算して、着地点を並べる
  const back: number[] = [RUNNER.touchFootS];
  while (true) {
    const p = back[back.length - 1];
    const next = p - stepLen(p - s0);
    if (next - s0 < 0.75) break;
    back.push(next);
  }
  const fwd = back.reverse();
  const N = fwd.length - 1;
  const lens = fwd.map((p, k) => p - (k === 0 ? s0 : fwd[k - 1]));
  const lastLen = lens[N];
  r.sTouch = RUNNER.touchFootS - RUNNER.footAheadFrac * lastLen;
  r.tArrive = runnerTimeAtS(r, r.sTouch);
  r.vArrive = V * (1 - Math.exp(-(r.tArrive - r.tStart) / r.tau));
  r.sStop = r.sTouch + (r.vArrive * r.vArrive) / (2 * RUNNER.stopDecel);
  // ベースの先: 駆け抜けて止まる
  let p = RUNNER.touchFootS;
  let len = lastLen;
  const after: number[] = [];
  while (true) {
    len *= 0.86;
    p += len;
    if (len < 0.45 || p - RUNNER.footAheadFrac * len > r.sStop) break;
    after.push(p);
  }
  const all = [...fwd, ...after];
  const allLens = [...lens, ...after.map((q, j) => q - (j === 0 ? RUNNER.touchFootS : after[j - 1]))];
  r.plants = all.map((s, k) => {
    const foot: 'L' | 'R' = (N - k) % 2 === 0 ? 'L' : 'R';
    const L = allLens[k];
    const bodyS = s - RUNNER.footAheadFrac * L;
    const bl = runnerL(r, bodyS);
    const l = k === N ? RUNNER.touchFootL : bl + (foot === 'L' ? FOOT_HALF_W : -FOOT_HALF_W);
    // ベースを踏むのは1歩だけ（前後の歩幅はベースより十分大きい）
    const onBag = k === N;
    return {
      s,
      l,
      y: (onBag ? BAG_HEIGHT : 0) + ANKLE_H,
      foot,
      len: L,
      bodyS,
      liftS: s + RUNNER.liftFrac * L,
      t: k === N ? r.tArrive : runnerTimeAtS(r, bodyS),
      onBag,
    };
  });
  r.touchIndex = N;
  // 構え: 投手に向かって肩幅に開く
  r.stance = {
    L: { s: s0 + (hand === 'R' ? -0.1 : 0.1), l: l0 + (hand === 'R' ? 0.32 : -0.32) },
    R: { s: s0 + (hand === 'R' ? 0.1 : -0.1), l: l0 + (hand === 'R' ? -0.32 : 0.32) },
  };
  return r;
}

// ---- 打球・送球 ----

export type Ground = { H: Vec3; G: Vec3; tHit: number; tField: number; K: number; hops: number[] };

export function groundPos(g: Ground, t: number): Vec3 {
  const T = g.tField - g.tHit;
  const tau = clamp(t - g.tHit, 0, T);
  const f = (1 - Math.exp(-tau / g.K)) / (1 - Math.exp(-T / g.K));
  const x = g.H.x + (g.G.x - g.H.x) * f;
  const z = g.H.z + (g.G.z - g.H.z) * f;
  // 弾み: f の区間ごとに放物線。最初は打った高さから落ちる
  const hops = g.hops;
  let y = g.G.y;
  for (let i = 0; i < hops.length - 1; i++) {
    const a = hops[i];
    const b = hops[i + 1];
    if (f >= a && f <= b) {
      const u = (f - a) / (b - a);
      const h = i === 0 ? 0 : 1.1 * Math.pow(0.5, i - 1) * (b - a) * 3;
      if (i === 0) y = g.H.y * (1 - u * u) + 0.037 * u * u;
      else y = 0.037 + 4 * h * u * (1 - u);
      break;
    }
  }
  if (f >= hops[hops.length - 1]) y = 0.037 + (g.G.y - 0.037) * smooth((f - hops[hops.length - 1]) / (1 - hops[hops.length - 1]));
  return { x, y, z };
}

export type Throw = { R: Vec3; C: Vec3; tRelease: number; tCatch: number };
export const GRAVITY = 9.8;

export function throwPos(th: Throw, t: number): Vec3 {
  const T = th.tCatch - th.tRelease;
  const tau = clamp(t - th.tRelease, 0, T);
  const u = tau / T;
  return {
    x: th.R.x + (th.C.x - th.R.x) * u,
    y: th.R.y + (th.C.y - th.R.y) * u + 0.5 * GRAVITY * tau * (T - tau),
    z: th.R.z + (th.C.z - th.R.z) * u,
  };
}

// ---- 1プレー ----

export type FielderPlan = {
  id: FielderId;
  P0: Vec3;
  Gbody: Vec3; // 捕球するときの立ち位置
  faceField: number; // 捕球するときの向き（yaw）
  throwBase: Vec3; // 投げるときの立ち位置
  faceThrow: number;
  tMove: number; // 動き出し
  kind: GroundKind;
};

// 打球の種類: ふつうのゴロ / 横への打球（三遊間・二遊間など） / 遅いゴロ（前に突っ込んで捕る）
export type GroundKind = 'routine' | 'side' | 'slow';

export type FirstBasePlan = {
  anchor: Vec3; // ベースに置く足（右足）
  stride: Vec3; // 送球側へ踏み出す足（左足）
  C: Vec3;
  dThrow: { x: number; z: number };
  wide: number;
};

export type Category = 'clear' | 'medium' | 'close';

export type Play = {
  index: number;
  fielder: FielderId;
  margin: number;
  out: boolean;
  category: Category;
  close: boolean;
  tPitch: number; // 投球のリリース
  pitchFrom: Vec3;
  tHit: number;
  runner: RunnerPlan;
  ground: Ground;
  fp: FielderPlan;
  th: Throw;
  fb: FirstBasePlan;
  tCatch: number;
  tArrive: number;
  requestRoll: number;
};

export const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);
// yaw の向き: 前 = (sin, 0, cos)、右 = (-cos, 0, sin)
export const fwdOf = (yaw: number) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
export const rightOf = (yaw: number) => ({ x: -Math.cos(yaw), z: Math.sin(yaw) });

// 投げる手（右手）のリリース位置。投げる人の向きと立ち位置に対する位置（右・上・前）
export const RELEASE_LOCAL = { x: 0.24, y: 1.72, z: 0.42 };
// 捕球の瞬間のグラブ（左手）の位置（右・上・前）
export const FIELD_GLOVE_LOCAL = { x: -0.12, y: 0.13, z: 0.55 };

export function localToWorld(base: Vec3, yaw: number, l: { x: number; y: number; z: number }): Vec3 {
  const f = fwdOf(yaw);
  const r = rightOf(yaw);
  return { x: base.x + r.x * l.x + f.x * l.z, y: base.y + l.y, z: base.z + r.z * l.x + f.z * l.z };
}

// correct: このゲームでここまでに正しく判定できた数。際どさの範囲と割合が決まる（config.ts の LEVELS）
export function pickMargin(
  rng: Rng,
  index: number,
  forced?: Partial<{ margin: number; category: Category; out: boolean }>,
  correct = index,
) {
  const d = difficulty(correct);
  if (forced?.margin !== undefined) {
    const m = forced.margin;
    const a = Math.abs(m);
    return { margin: m, closeMax: d.closeMax, category: (a <= d.closeMax ? 'close' : a < d.mediumMax ? 'medium' : 'clear') as Category };
  }
  let out = rng() < 0.5;
  if (forced?.out !== undefined) out = forced.out;
  let category: Category;
  if (forced?.category) category = forced.category;
  else if (index < STAGE.tutorial) category = 'clear';
  else {
    const r = rng();
    category = r < d.pClose ? 'close' : r < d.pClose + d.pMedium ? 'medium' : 'clear';
  }
  let mag: number;
  if (category === 'close') mag = d.closeMin + (d.closeMax - d.closeMin) * rng();
  else if (category === 'medium') mag = d.mediumMin + (d.mediumMax - d.mediumMin) * rng();
  else if (index < STAGE.tutorial) mag = 0.3 + 0.2 * rng();
  else {
    mag = d.clearMin + d.clearWidth * rng();
  }
  return { margin: out ? mag : -mag, closeMax: d.closeMax, category };
}

export type Force = Partial<{
  margin: number;
  category: Category;
  out: boolean;
  fielder: FielderId;
  hand: 'R' | 'L';
}>;

const FIELDER_WEIGHTS: [FielderId, number][] = [
  ['SS', 0.38],
  ['3B', 0.24],
  ['2B', 0.26],
  ['P', 0.12],
];

export function generatePlay(rng: Rng, index: number, force: Force = {}, correct = index): Play {
  const { margin, category, closeMax } = pickMargin(rng, index, force, correct);
  const hand: 'R' | 'L' = force.hand ?? (index >= STAGE.lefty && rng() < 0.35 ? 'L' : 'R');
  const V = range(rng, hand === 'R' ? RUNNER.topSpeedR : RUNNER.topSpeedL);
  const tHit = GAME.tHit;
  const runner = makeRunner(hand, V, tHit);
  const tArrive = runner.tArrive;
  const tCatch = tArrive - margin;
  const H: Vec3 = { x: 0.05, y: 0.75, z: -0.35 };

  let fielder: FielderId = force.fielder ?? 'SS';
  for (let attempt = 0; attempt < 2000; attempt++) {
    const relax = Math.floor(attempt / 400); // 見つからないときは条件をゆるめる
    if (!force.fielder) {
      let r = rng();
      for (const [id, w] of FIELDER_WEIGHTS) {
        fielder = id;
        if ((r -= w) <= 0) break;
      }
    }
    const def = FIELDERS[fielder];
    const P0: Vec3 = { x: def.pos.x, y: 0, z: def.pos.z };
    // 捕球点: 定位置から前後左右にずらす
    const toHome = { x: -P0.x, z: -P0.z };
    const dh = Math.hypot(toHome.x, toHome.z);
    const hx = toHome.x / dh;
    const hz = toHome.z / dh;
    const kr = rng();
    const kind: GroundKind = fielder === 'P' ? 'routine' : kr < 0.25 ? 'slow' : kr < 0.6 ? 'side' : 'routine';
    let charge: number;
    let lat: number;
    if (fielder === 'P') {
      // 投手ゴロはボテボテの当たり。マウンドから前に出て捕る
      charge = range(rng, [0, 3]);
      lat = range(rng, [-1.5, 1.5]);
    } else if (kind === 'slow') {
      charge = range(rng, [3, 7 + relax]);
      lat = range(rng, [-1.5, 1.5]);
    } else if (kind === 'side') {
      charge = range(rng, [-1.5, 1.5]);
      lat = (rng() < 0.5 ? -1 : 1) * range(rng, [2.5, 4.8]);
    } else {
      charge = range(rng, [-1, 3 + relax]);
      lat = range(rng, [-2, 2]);
    }
    const gx = P0.x + hx * charge - hz * lat;
    const gz = P0.z + hz * charge + hx * lat;
    const faceField = yawOf(H.x - gx, H.z - gz);
    // グラブが捕球点に来るよう立ち位置を決める
    const gl = FIELD_GLOVE_LOCAL;
    const Gbody0 = localToWorld({ x: 0, y: 0, z: 0 }, faceField, gl);
    const Gbody: Vec3 = { x: gx - Gbody0.x, y: 0, z: gz - Gbody0.z };
    const G: Vec3 = { x: gx, y: gl.y, z: gz };
    // 送球: 一塁方向へ一歩踏み出して投げる
    const to1b = { x: BAG_CENTER.x - Gbody.x, z: BAG_CENTER.z - Gbody.z };
    const d1 = Math.hypot(to1b.x, to1b.z);
    const step = fielder === '2B' || fielder === 'P' ? 0.45 : 0.75;
    const throwBase: Vec3 = { x: Gbody.x + (to1b.x / d1) * step, y: 0, z: Gbody.z + (to1b.z / d1) * step };
    const faceThrow = yawOf(BAG_CENTER.x - throwBase.x, BAG_CENTER.z - throwBase.z);
    const R = localToWorld(throwBase, faceThrow, RELEASE_LOCAL);
    // 一塁手の捕球点: ベースから送球の来る方向へ伸びる
    const dx = R.x - BAG_CENTER.x;
    const dz = R.z - BAG_CENTER.z;
    const dd = Math.hypot(dx, dz);
    const dThrow = { x: dx / dd, z: dz / dd };
    const wideMax = index >= STAGE.wideThrow ? 0.55 : 0.18;
    const wide = range(rng, [-wideMax, wideMax]);
    const reach = range(rng, [1.0, 1.3]);
    const cy = range(rng, index >= STAGE.wideThrow ? [0.55, 1.6] : [0.85, 1.35]);
    const C: Vec3 = {
      x: BAG_CENTER.x + dThrow.x * reach - dThrow.z * wide,
      y: cy,
      z: BAG_CENTER.z + dThrow.z * reach + dThrow.x * wide,
    };
    const vt = range(rng, def.throwSpeed);
    const dist = Math.hypot(C.x - R.x, C.y - R.y, C.z - R.z);
    const T = dist / vt;
    const tRelease = tCatch - T;
    const transfer = range(rng, fielder === 'P' ? [0.5, 0.85 + 0.3 * relax] : [0.55, 1.0 + 0.3 * relax]);
    const tField = tRelease - transfer;
    const Tg = tField - tHit;
    if (Tg <= 0.4) continue;
    const gd = Math.hypot(G.x - H.x, G.z - H.z);
    const avg = gd / Tg;
    // 遅いゴロは本当に遅い打球だけ（平均 7〜16 m/s）
    const minV = kind === 'slow' ? 7 : fielder === 'P' ? 5 : Math.max(5, 11 - 2 * relax);
    const maxV = kind === 'slow' ? 16 + 3 * relax : 40 + 4 * relax;
    if (avg < minV || avg > maxV) continue;
    // 定位置から捕球点まで間に合うか
    const tMove = tHit + 0.2;
    const moveD = Math.hypot(Gbody.x - P0.x, Gbody.z - P0.z);
    if (moveD > 6.5 * Math.max(0, tField - 0.15 - tMove)) continue;
    // 送球中に一塁手がベースへ着ける
    if (tRelease < tHit + 1.6) continue;

    // 弾み（打球の速さで回数を変える）
    const nh = avg > 28 ? 4 : avg > 18 ? 5 : 6;
    const hops = [0];
    for (let i = 1; i <= nh; i++) hops.push(1 - Math.pow(1 - i / (nh + 1), 1.6));
    const ground: Ground = { H, G, tHit, tField, K: clamp(Tg * 0.9, 0.6, 3), hops };

    const anchor: Vec3 = {
      x: BAG_CENTER.x + dThrow.x * 0.12 + dThrow.z * 0.04,
      y: BAG_HEIGHT + ANKLE_H,
      z: BAG_CENTER.z + dThrow.z * 0.12 - dThrow.x * 0.04,
    };
    const strideLen = 0.75 + 0.35 * clamp(reach - 1, 0, 1);
    const stride: Vec3 = {
      x: BAG_CENTER.x + dThrow.x * (0.12 + strideLen) - dThrow.z * (wide * 0.7 - 0.16),
      y: ANKLE_H,
      z: BAG_CENTER.z + dThrow.z * (0.12 + strideLen) + dThrow.x * (wide * 0.7 - 0.16),
    };
    const pitchFrom: Vec3 = { ...PITCH_RELEASE };
    return {
      index,
      fielder,
      margin,
      out: margin > 0,
      category,
      close: Math.abs(margin) <= closeMax, // 際どいかどうかは差の大きさだけで決める
      tPitch: tHit - 0.5,
      pitchFrom,
      tHit,
      runner,
      ground,
      fp: { id: fielder, P0, Gbody, faceField, throwBase, faceThrow, tMove, kind },
      th: { R, C, tRelease, tCatch },
      fb: { anchor, stride, C, dThrow, wide },
      tCatch,
      tArrive,
      requestRoll: rng(),
    };
  }
  throw new Error('generatePlay: no solution');
}

// 投球（投手 → 打者）
export function pitchPos(p: Play, t: number): Vec3 {
  const T = p.tHit - p.tPitch;
  const u = clamp((t - p.tPitch) / T, 0, 1);
  const H = p.ground.H;
  const tau = u * T;
  return {
    x: p.pitchFrom.x + (H.x - p.pitchFrom.x) * u,
    y: p.pitchFrom.y + (H.y - p.pitchFrom.y) * u + 0.5 * GRAVITY * 0.5 * tau * (T - tau),
    z: p.pitchFrom.z + (H.z - p.pitchFrom.z) * u,
  };
}

// ボールの位置と、誰が持っているか
export type BallState = { pos: Vec3; phase: 'pitch' | 'ground' | 'held' | 'throw' | 'caught' };
export function ballAt(p: Play, t: number): BallState {
  if (t < p.tPitch) return { pos: p.pitchFrom, phase: 'held' };
  if (t < p.tHit) return { pos: pitchPos(p, t), phase: 'pitch' };
  if (t < p.ground.tField) return { pos: groundPos(p.ground, t), phase: 'ground' };
  if (t < p.th.tRelease) return { pos: p.ground.G, phase: 'held' };
  if (t < p.th.tCatch) return { pos: throwPos(p.th, t), phase: 'throw' };
  return { pos: p.th.C, phase: 'caught' };
}

// 着地点（世界座標）
export function plantWorld(pl: Plant): Vec3 {
  return lineToWorld(pl.s, pl.l, pl.y);
}
