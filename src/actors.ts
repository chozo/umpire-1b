import * as THREE from 'three';
import { BAG_CENTER, BASE_DIST, FIELDERS, FIRST_BASEMAN_READY, U, lineToWorld, moundY, type FielderId, type Vec3 } from './config';
import {
  Figure,
  localToRig,
  mirrorLocal,
  newPose,
  sampleKeys,
  type LocalPose,
  type Look,
  type RigPose,
} from './figure';
import {
  ANKLE_H,
  PITCHER_BASE,
  RELEASE_LOCAL,
  FIELD_GLOVE_LOCAL,
  ballAt,
  fwdOf,
  rightOf,
  runnerL,
  runnerS,
  yawOf,
  type Play,
  type Plant,
} from './play';

const V = THREE.Vector3;
type V3 = THREE.Vector3;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (u: number) => {
  const k = clamp(u, 0, 1);
  return k * k * (3 - 2 * k);
};
const angLerp = (a: number, b: number, u: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
};

// 世界座標の姿勢どうしを補間する
export function lerpRig(a: RigPose, b: RigPose, u: number, out: RigPose) {
  out.pelvis.lerpVectors(a.pelvis, b.pelvis, u);
  out.yaw = angLerp(a.yaw, b.yaw, u);
  out.lean = a.lean + (b.lean - a.lean) * u;
  out.side = a.side + (b.side - a.side) * u;
  out.twist = a.twist + (b.twist - a.twist) * u;
  out.headYaw = a.headYaw + (b.headYaw - a.headYaw) * u;
  out.headPitch = a.headPitch + (b.headPitch - a.headPitch) * u;
  out.lFoot.lerpVectors(a.lFoot, b.lFoot, u);
  out.rFoot.lerpVectors(a.rFoot, b.rFoot, u);
  out.lFootYaw = angLerp(Number.isNaN(a.lFootYaw) ? a.yaw : a.lFootYaw, Number.isNaN(b.lFootYaw) ? b.yaw : b.lFootYaw, u);
  out.rFootYaw = angLerp(Number.isNaN(a.rFootYaw) ? a.yaw : a.rFootYaw, Number.isNaN(b.rFootYaw) ? b.yaw : b.rFootYaw, u);
  out.lToe = a.lToe + (b.lToe - a.lToe) * u;
  out.rToe = a.rToe + (b.rToe - a.rToe) * u;
  out.lHand.lerpVectors(a.lHand, b.lHand, u);
  out.rHand.lerpVectors(a.rHand, b.rHand, u);
  out.lElbowPole = u < 0.5 ? a.lElbowPole : b.lElbowPole;
  out.rElbowPole = u < 0.5 ? a.rElbowPole : b.rElbowPole;
  out.bat = u < 0.5 ? a.bat : b.bat;
  out.gloveDir = a.gloveDir && b.gloveDir ? new V().lerpVectors(a.gloveDir, b.gloveDir, u) : u < 0.5 ? a.gloveDir : b.gloveDir;
  return out;
}

// ---- チームの見た目 ----
export const HOME: Look = { jersey: 0xf2f1ea, pants: 0xf2f1ea, cap: 0x1d2a4f, socks: 0x1d2a4f, glove: 'L' };
export const AWAY: Look = { jersey: 0x8f97a4, pants: 0x8f97a4, cap: 0xb3262e, socks: 0xb3262e, helmet: true };
const UMP: Look = { jersey: 0x1c2333, pants: 0x5b616e, cap: 0x111827, socks: 0x111827, kind: 'umpire' };

// ---- キーフレーム（x = 右、y = 上、z = 前） ----
type P3 = [number, number, number];
const L = (o: Partial<LocalPose> & { p: P3; lf: P3; rf: P3; lh: P3; rh: P3 }): LocalPose => ({
  lean: 0,
  side: 0,
  twist: 0,
  hy: 0,
  hp: 0,
  ...o,
});

const STAND = L({ p: [0, 0.95, 0], lean: 0.05, lf: [-0.13, 0.08, 0], rf: [0.13, 0.08, 0], lh: [-0.24, 0.8, 0.06], rh: [0.24, 0.8, 0.06] });
const READY = L({
  p: [0, 0.8, 0],
  lean: 0.5,
  hp: -0.45,
  lf: [-0.33, 0.08, 0.05],
  rf: [0.33, 0.08, 0.05],
  lh: [-0.17, 0.6, 0.42],
  rh: [0.17, 0.6, 0.42],
});
const FIELD = L({
  p: [0, 0.52, -0.05],
  lean: 1.15,
  hp: -0.7,
  lf: [-0.36, 0.08, 0.2],
  rf: [0.34, 0.08, -0.12],
  lh: [FIELD_GLOVE_LOCAL.x, FIELD_GLOVE_LOCAL.y, FIELD_GLOVE_LOCAL.z],
  rh: [0.06, 0.2, 0.48],
});
const RISE = L({ p: [0, 0.9, 0], lean: 0.2, lf: [-0.2, 0.08, 0.15], rf: [0.2, 0.08, -0.15], lh: [-0.06, 1.15, 0.3], rh: [0.04, 1.12, 0.28] });
const R = RELEASE_LOCAL;
const THROW_KEYS: [number, LocalPose][] = [
  [-0.32, L({ p: [0, 0.9, -0.1], lean: 0.15, twist: -0.9, hy: 0.6, lf: [-0.15, 0.08, 0.25], rf: [0.15, 0.08, -0.35], lh: [-0.05, 1.25, 0.25], rh: [0.05, 1.2, 0.2] })],
  [
    -0.13,
    L({ p: [0, 0.87, 0.12], lean: 0.05, side: 0.15, twist: -1.0, hy: 0.9, lf: [-0.1, 0.14, 0.72], rf: [0.12, 0.08, -0.35], lh: [-0.25, 1.35, 0.55], rh: [0.42, 1.55, -0.42] }),
  ],
  [0, L({ p: [0, 0.84, 0.3], lean: 0.45, side: -0.1, twist: 0.5, hy: -0.3, lf: [-0.12, 0.08, 0.75], rf: [0.15, 0.15, -0.3], lh: [-0.3, 0.95, 0.25], rh: [R.x, R.y, R.z] })],
  [0.22, L({ p: [0, 0.75, 0.45], lean: 0.85, twist: 0.7, hy: -0.5, lf: [-0.12, 0.08, 0.75], rf: [0.25, 0.32, -0.1], lh: [-0.35, 0.75, 0.3], rh: [-0.25, 0.7, 0.65] })],
  [0.75, L({ p: [0, 0.93, 0.45], lean: 0.1, lf: [-0.15, 0.08, 0.7], rf: [0.2, 0.08, 0.3], lh: [-0.24, 0.85, 0.5], rh: [0.24, 0.82, 0.5] })],
];

// 右投手のセットポジションからの投球（t = 0 がリリース）。立ち位置の向き = 本塁
const PITCH_KEYS: [number, LocalPose][] = [
  [-1.2, L({ yo: -1.57, p: [0, 0.95, 0], lean: 0.05, hy: 1.4, lf: [0, 0.08, 0.22], rf: [0, 0.08, -0.15], lh: [0.24, 1.22, 0.02], rh: [0.24, 1.2, -0.02] })],
  [-0.6, L({ yo: -1.7, p: [0, 0.98, -0.05], lean: 0, hy: 1.5, lf: [0.05, 0.6, 0.05], rf: [0, 0.08, -0.15], lh: [0.24, 1.25, 0.0], rh: [0.24, 1.22, -0.04] })],
  [-0.22, L({ yo: -1.2, p: [0, 0.85, 0.35], lean: 0.05, twist: -0.6, hy: 1.1, lf: [-0.15, 0.04, 1.0], rf: [0, 0.08, -0.15], lh: [-0.1, 1.35, 0.9], rh: [0.55, 1.5, -0.45] })],
  [0, L({ p: [0, 0.8, 0.65], lean: 0.55, twist: 0.4, lf: [-0.18, 0.03, 1.05], rf: [0.12, 0.16, -0.1], lh: [-0.3, 1.0, 0.6], rh: [0.35, 1.62, 1.25] })],
  [0.3, L({ p: [0, 0.7, 0.85], lean: 0.9, twist: 0.6, hp: -0.4, lf: [-0.18, 0.03, 1.05], rf: [0.2, 0.3, 0.3], lh: [-0.35, 0.8, 0.6], rh: [-0.3, 0.6, 1.1] })],
  [0.8, L({ p: [0, 0.82, 1.0], lean: 0.4, hp: -0.4, lf: [-0.3, 0.03, 1.0], rf: [0.3, 0.03, 0.9], lh: [-0.18, 0.62, 1.4], rh: [0.18, 0.62, 1.4] })],
];

// 右打者（立ち位置の向き = 本塁ベース側）。t = 0 が打つ瞬間
const BAT_KEYS: [number, LocalPose][] = [
  [-0.6, L({ p: [0.05, 0.9, -0.05], lean: 0.2, hy: 1.2, lf: [-0.32, 0.08, 0], rf: [0.3, 0.08, 0.02], lh: [0.12, 1.28, 0.15], rh: [0.15, 1.34, 0.12], bat: [0.35, 0.85, -0.3] })],
  [-0.15, L({ p: [-0.05, 0.86, -0.05], lean: 0.2, twist: -0.4, hy: 1.2, lf: [-0.55, 0.08, 0.02], rf: [0.3, 0.08, 0.02], lh: [0.2, 1.25, 0.0], rh: [0.24, 1.3, -0.02], bat: [0.35, 0.9, -0.2] })],
  [0, L({ p: [-0.12, 0.88, 0], lean: 0.25, twist: 0.6, hy: 1.0, lf: [-0.55, 0.08, 0.02], rf: [0.3, 0.1, 0.02], lh: [-0.05, 0.95, 0.38], rh: [-0.02, 0.98, 0.36], bat: [-0.75, -0.3, 0.6] })],
  [0.22, L({ p: [-0.2, 0.9, 0], lean: 0.15, twist: 1.2, hy: 0.6, lf: [-0.55, 0.08, 0.02], rf: [0.25, 0.15, 0.05], lh: [-0.3, 1.38, 0.05], rh: [-0.28, 1.36, 0.0], bat: [0.2, 0.3, -0.9] })],
];

const CROUCH_C = L({ p: [0, 0.5, 0], lean: 0.3, lf: [-0.3, 0.08, 0.12], rf: [0.3, 0.08, 0.12], lh: [-0.15, 0.72, 0.45], rh: [0.2, 0.5, 0.25] });
const CROUCH_U = L({ p: [0, 0.75, 0], lean: 0.45, hp: -0.4, lf: [-0.3, 0.08, 0.0], rf: [0.3, 0.08, -0.05], lh: [-0.2, 0.55, 0.3], rh: [0.2, 0.55, 0.3] });
const SIT = L({ p: [0, 0.5, 0], lean: 0.12, lf: [-0.15, 0.08, 0.42], rf: [0.15, 0.08, 0.42], lh: [-0.16, 0.55, 0.32], rh: [0.16, 0.55, 0.32] });
const RAIL = L({ p: [0, 0.95, 0], lean: 0.2, lf: [-0.14, 0.08, -0.05], rf: [0.14, 0.08, 0.05], lh: [-0.22, 1.0, 0.38], rh: [0.22, 1.0, 0.38] });

// 監督のリクエスト（両手で四角＝モニターを描く）。c = 演出の経過時間
const REQ_KEYS: [number, LocalPose][] = [
  [0.9, STAND],
  [1.25, L({ p: [0, 0.95, 0], lean: 0.02, lf: [-0.14, 0.08, 0], rf: [0.14, 0.08, 0], lh: [-0.05, 1.6, 0.42], rh: [0.05, 1.6, 0.42] })],
  [1.55, L({ p: [0, 0.95, 0], lean: 0.02, lf: [-0.14, 0.08, 0], rf: [0.14, 0.08, 0], lh: [-0.36, 1.6, 0.4], rh: [0.36, 1.6, 0.4] })],
  [1.85, L({ p: [0, 0.95, 0], lean: 0.02, lf: [-0.14, 0.08, 0], rf: [0.14, 0.08, 0], lh: [-0.36, 1.17, 0.4], rh: [0.36, 1.17, 0.4] })],
  [2.15, L({ p: [0, 0.95, 0], lean: 0.02, lf: [-0.14, 0.08, 0], rf: [0.14, 0.08, 0], lh: [-0.05, 1.17, 0.42], rh: [0.05, 1.17, 0.42] })],
  [2.6, L({ p: [0, 0.95, 0], lean: 0.02, lf: [-0.14, 0.08, 0], rf: [0.14, 0.08, 0], lh: [-0.05, 1.17, 0.42], rh: [0.05, 1.17, 0.42] })],
  [3.0, STAND],
];
export const REQ_DRAW = { from: 1.25, to: 2.15, end: 3.0 };

// 走る姿勢（その場の足踏み。phase は歩幅に合わせて進める）
function runLocal(phase: number, amp: number): LocalPose {
  const c = Math.cos(phase);
  const s = Math.sin(phase);
  return L({
    p: [0, 0.92 - 0.04 * amp + 0.03 * amp * Math.abs(c), 0],
    lean: 0.15 + 0.2 * amp,
    lf: [-0.12, 0.08 + 0.22 * amp * Math.max(0, s), 0.38 * amp * c],
    rf: [0.12, 0.08 + 0.22 * amp * Math.max(0, -s), -0.38 * amp * c],
    lh: [-0.2, 0.95, 0.12 - 0.3 * amp * c],
    rh: [0.2, 0.95, 0.12 + 0.3 * amp * c],
  });
}

const tmpA = newPose();
const tmpB = newPose();

export type Dugout = { pos: Vec3; yaw: number; back: Vec3 };

// 打った瞬間の小さなジャンプ（スプリットステップ）。腰の高さに足す
function splitStep(p: Play, t: number) {
  return 0.06 * bump(t, p.tHit - 0.08, p.tHit + 0.06, p.tHit + 0.22);
}

const SECOND_BASE = { x: 0, z: -BASE_DIST * Math.SQRT2 };

// 打球に関わらない内野手の行き先: 二塁ベースのカバー、または打球の方へ数歩
function infieldTarget(p: Play, id: '3B' | 'SS' | '2B') {
  const pos = FIELDERS[id].pos;
  // 遊撃手・三塁手の打球は二塁手が、二塁手・投手の打球は遊撃手が二塁ベースに入る
  const cover = p.fielder === 'SS' || p.fielder === '3B' ? '2B' : 'SS';
  if (id === cover) return { x: SECOND_BASE.x + (id === '2B' ? 0.8 : -0.8), z: SECOND_BASE.z + 1.0 };
  const G = p.ground.G;
  const dx = G.x - pos.x;
  const dz = G.z - pos.z;
  const d = Math.hypot(dx, dz);
  const go = Math.min(2.2, Math.max(0, d - 3));
  return d > 0 ? { x: pos.x + (dx / d) * go, z: pos.z + (dz / d) * go } : null;
}

// t が a → b で 0 → 1、b → c で 1 → 0 になる山
function bump(t: number, a: number, b: number, c: number) {
  if (t <= a || t >= c) return 0;
  return t < b ? smooth((t - a) / (b - a)) : 1 - smooth((t - b) / (c - b));
}

export class Cast {
  readonly batter: Figure;
  readonly pitcher: Figure;
  readonly catcher: Figure;
  readonly plateUmp: Figure;
  readonly firstBase: Figure;
  readonly fielders: Record<Exclude<FielderId, 'P'>, Figure>;
  readonly outfield: Figure[] = [];
  readonly managers: { home: Figure; away: Figure };
  readonly bench: Figure[] = [];
  readonly droppedBat: THREE.Mesh;
  private pose = newPose();
  private batHeld = true;
  dugouts: { home: Dugout; away: Dugout };

  constructor(scene: THREE.Scene, dugouts: { home: Dugout; away: Dugout }) {
    this.dugouts = dugouts;
    const add = (f: Figure) => {
      scene.add(f.group);
      return f;
    };
    // 走者の靴は赤。ベースの上で一塁手の黒い靴と見分けやすくする
    this.batter = add(new Figure({ ...AWAY, number: '7', shoes: 0xe0322f }));
    this.batter.setBat(true);
    this.pitcher = add(new Figure({ ...HOME, number: '18' }));
    this.catcher = add(new Figure({ ...HOME, number: '27', helmet: true }));
    this.plateUmp = add(new Figure(UMP));
    this.firstBase = add(new Figure({ ...HOME, number: '3' }));
    this.fielders = {
      '3B': add(new Figure({ ...HOME, number: '5' })),
      SS: add(new Figure({ ...HOME, number: '6' })),
      '2B': add(new Figure({ ...HOME, number: '4' })),
    };
    for (const n of ['8', '9', '1']) this.outfield.push(add(new Figure({ ...HOME, number: n })));
    this.managers = {
      home: add(new Figure({ ...HOME, glove: null, number: '77', kind: 'manager' })),
      away: add(new Figure({ ...AWAY, helmet: false, glove: null, number: '88', kind: 'manager' })),
    };
    for (const side of ['home', 'away'] as const) {
      for (let i = 0; i < 4; i++) {
        const f = add(new Figure({ ...(side === 'home' ? HOME : AWAY), helmet: false, glove: null, number: String(10 + i * 3) }));
        this.bench.push(f);
        const d = dugouts[side];
        const along = rightOf(d.yaw);
        const k = (i - 1.5) * 1.6 + (i >= 2 ? 1.2 : -1.2);
        const base = { x: d.back.x + along.x * k, y: 0.0, z: d.back.z + along.z * k };
        f.apply(localToRig(base, d.yaw, i % 2 === 0 ? SIT : RAIL, newPose()));
        if (i % 2 === 1) {
          const fw = fwdOf(d.yaw);
          f.apply(localToRig({ x: d.pos.x + along.x * k - fw.x * 0.35, y: 0, z: d.pos.z + along.z * k - fw.z * 0.35 }, d.yaw, RAIL, newPose()));
        }
      }
    }
    const bg = new THREE.CylinderGeometry(0.033, 0.017, 0.84, 10);
    this.droppedBat = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0xd8b27a, roughness: 0.5 }));
    this.droppedBat.castShadow = true;
    this.droppedBat.visible = false;
    scene.add(this.droppedBat);
  }

  // ---- 1プレーの時刻 t の姿 ----
  update(p: Play, t: number) {
    this.updateBatter(p, t);
    this.updatePitcher(p, t);
    this.updateCatcherUmp(p, t);
    this.updateFielders(p, t);
    this.updateFirstBase(p, t);
    this.updateOutfield(p, t);
    this.managerIdle();
  }

  // ボールを持っている手の位置（捕ってから投げるまで）
  heldBall(p: Play, t: number, out: V3): boolean {
    const st = ballAt(p, t);
    if (st.phase === 'held' && t >= p.ground.tField) {
      const f = this.fielderFig(p.fielder);
      if (t < p.ground.tField + 0.2) out.copy(f.j.lHand);
      else out.copy(f.j.rHand);
      return true;
    }
    if (st.phase === 'held' && t < p.tPitch) {
      out.copy(this.pitcher.j.rHand);
      return true;
    }
    if (st.phase === 'caught' && t > p.tCatch + 0.05) {
      // 捕った後はグラブと一緒に動く（捕った瞬間の位置との差だけずらす）
      out.copy(this.firstBase.j.lHand).add(this.catchOffset);
      return true;
    }
    return false;
  }
  private catchOffset = new V();

  fielderFig(id: FielderId) {
    return id === 'P' ? this.pitcher : this.fielders[id];
  }

  private updateBatter(p: Play, t: number) {
    const r = p.runner;
    const lefty = r.hand === 'L';
    const startW = lineToWorld(r.s0, r.l0);
    const baseYaw = lefty ? -Math.PI / 2 : Math.PI / 2;
    const keys = lefty ? BAT_KEYS.map(([k, v]) => [k, mirrorLocal(v)] as [number, LocalPose]) : BAT_KEYS;
    const tRun = r.tStart;
    if (t < tRun) {
      const lp = sampleKeys(keys, t - p.tHit);
      // 構えた後、走り出すまでにバットを置く
      localToRig(startW, baseYaw, lp, this.pose);
      if (t > p.tHit + 0.24) this.pose.bat = null;
      if (t > p.tHit + 0.18) {
        const u = smooth((t - p.tHit - 0.18) / (tRun - p.tHit - 0.18 + 0.25));
        this.runnerPose(p, Math.max(t, tRun), tmpA);
        lerpRig(this.pose, tmpA, u * 0.6, this.pose);
        this.pose.bat = null;
      }
    } else {
      this.runnerPose(p, t, this.pose);
      if (t < tRun + 0.25) {
        localToRig(startW, baseYaw, sampleKeys(keys, 0.22), tmpB);
        this.runnerPose(p, t, tmpA);
        lerpRig(tmpB, tmpA, 0.6 + 0.4 * smooth((t - tRun) / 0.25), this.pose);
        this.pose.bat = null;
      }
    }
    const held = t <= p.tHit + 0.24;
    if (held !== this.batHeld) this.batHeld = held;
    this.batter.setBat(held);
    this.batter.apply(this.pose);
    // 置いたバット
    this.droppedBat.visible = !held;
    if (!held) {
      const s = lefty ? 1 : -1;
      this.droppedBat.position.set(startW.x + 0.5 * s, 0.035, startW.z + 0.6);
      this.droppedBat.rotation.set(Math.PI / 2, 0, 0.6 * s);
    }
  }

  // 走者の姿勢（着地点に足を合わせる）
  runnerPose(p: Play, t: number, out: RigPose) {
    const r = p.runner;
    const s = runnerS(r, t);
    const lb = runnerL(r, s);
    const plants = r.plants;
    // 何歩目か（小数）
    let k = -1;
    for (let i = 0; i < plants.length; i++) if (plants[i].bodyS <= s) k = i;
    let frac = 0;
    if (k >= 0 && k + 1 < plants.length) frac = (s - plants[k].bodyS) / (plants[k + 1].bodyS - plants[k].bodyS);
    else if (k < 0) frac = (s - r.s0) / Math.max(1e-3, plants[0].bodyS - r.s0);
    const phase = k + clamp(frac, 0, 1);
    const stopped = s >= r.sStop - 0.02;
    // 腰の上下（着地で低く）
    const bob = stopped ? 0 : 0.035 * Math.cos(2 * Math.PI * (phase - Math.floor(phase)));
    const speedK = clamp((t - r.tStart) / 0.5, 0, 1) * (t > r.tArrive ? clamp(1 - (t - r.tArrive) / 2.2, 0.15, 1) : 1);
    const yaw = Math.atan2(U.x, U.z);
    // ベースを踏む一歩: 上体を前に倒し、腰を落とし、ベースを見る（駆け抜けの「飛び込むような」一歩）
    const dive = stopped ? 0 : bump(t, r.tArrive - 0.16, r.tArrive, r.tArrive + 0.14);
    const w = lineToWorld(s, lb, 0.9 + bob - 0.05 * speedK - 0.06 * dive);
    out.pelvis.set(w.x, w.y, w.z);
    out.yaw = yaw;
    out.lean = 0.14 + 0.3 * speedK + (t < r.tStart + 0.6 ? 0.15 * (1 - (t - r.tStart) / 0.6) : 0) + 0.2 * dive;
    if (t > r.tArrive) out.lean -= 0.25 * smooth((t - r.tArrive) / 0.8);
    out.side = 0;
    out.headYaw = 0;
    out.headPitch = -0.1 - 0.35 * dive;
    // 足
    this.footAt(p, s, 'L', out.lFoot);
    this.footAt(p, s, 'R', out.rFoot);
    out.lFootYaw = yaw;
    out.rFootYaw = yaw;
    out.lToe = 0;
    out.rToe = 0;
    // 腕振り（足と逆）。a = +1 で右腕が前
    const pk = plants[Math.max(0, Math.floor(phase))] ?? plants[0];
    const sign = pk.foot === 'L' ? 1 : -1;
    const a = stopped ? 0 : sign * Math.cos(Math.PI * (phase - Math.floor(phase))) * speedK;
    out.twist = -0.12 * a; // 腕振りに合わせて肩を少しひねる
    const fw = fwdOf(yaw);
    const rt = rightOf(yaw);
    // 肩の高さ（前かがみに合わせて前に出る）。肘を曲げたまま、前の手は胸の高さまで、後ろの手は腰の後ろまで振る
    const shY = out.pelvis.y + 0.5 * Math.cos(out.lean);
    const shF = 0.5 * Math.sin(out.lean);
    const hand = (side: number, swing: number, o: V3) => {
      const u = (swing + 1) / 2; // 0 = いちばん後ろ、1 = いちばん前
      const f = shF + (-0.2 + 0.45 * u);
      const y = shY - 0.42 + 0.34 * u * u;
      const sd = 0.2 - 0.04 * u; // 前に振ると体の中心へ少し寄る
      o.set(out.pelvis.x + rt.x * sd * side + fw.x * f, y, out.pelvis.z + rt.z * sd * side + fw.z * f);
    };
    // 止まっているとき・走り出し前は手を下ろした位置（swing = -0.2 あたり）
    hand(1, stopped ? -0.2 : a, out.rHand);
    hand(-1, stopped ? -0.2 : -a, out.lHand);
    out.lElbowPole = null;
    out.rElbowPole = null;
    out.bat = null;
    out.gloveDir = null;
    return out;
  }

  // ある足の位置（腰の位置 s のとき）
  private footAt(p: Play, s: number, foot: 'L' | 'R', o: V3) {
    const r = p.runner;
    const plants = r.plants;
    const st = r.stance[foot];
    const stanceW = lineToWorld(st.s, st.l, ANKLE_H);
    // この足の着地点の並び
    let prev: { w: Vec3; liftS: number } | null = null;
    let next: Plant | null = null;
    let landed: Plant | null = null;
    for (let i = 0; i < plants.length; i++) {
      const pl = plants[i];
      if (pl.foot !== foot) continue;
      if (pl.bodyS <= s) landed = pl;
      else {
        next = pl;
        break;
      }
    }
    if (landed) prev = { w: lineToWorld(landed.s, landed.l, landed.y), liftS: landed.liftS };
    else {
      // まだ一度も着地していない: 構えの位置から（最初の一歩の足はすぐ離れる）
      const first = plants[0];
      const liftS = first.foot === foot ? r.s0 : first.bodyS + 0.15;
      prev = { w: stanceW, liftS };
    }
    if (!next || s <= prev.liftS) {
      o.set(prev.w.x, prev.w.y, prev.w.z);
      return;
    }
    const nw = lineToWorld(next.s, next.l, next.y);
    const u = clamp((s - prev.liftS) / (next.bodyS - prev.liftS), 0, 1);
    const e = smooth(u);
    // 足を上げる高さ。離れてすぐ高く上げ（かかとを蹴り上げる）、前へ振り出して着地する
    const hu = Math.sin(Math.PI * Math.pow(u, 0.7));
    const h = (0.2 + 0.16 * clamp(next.len / 2, 0, 1)) * hu + 0.1 * hu ** 3;
    o.set(prev.w.x + (nw.x - prev.w.x) * e, prev.w.y + (nw.y - prev.w.y) * u + h, prev.w.z + (nw.z - prev.w.z) * e);
  }

  private updatePitcher(p: Play, t: number) {
    const tr = p.tPitch;
    if (p.fielder === 'P' && t > p.tHit + 0.15) {
      this.activeFielder(p, t, this.pitcher);
      return;
    }
    const lp = sampleKeys(PITCH_KEYS, t - tr);
    localToRig(PITCHER_BASE, 0, lp, this.pose);
    // 投げた後はボールの方を向く
    if (t > p.tHit + 0.3) {
      const b = ballAt(p, t).pos;
      const lp2 = sampleKeys(PITCH_KEYS, 0.8);
      const base = { x: PITCHER_BASE.x, y: PITCHER_BASE.y, z: PITCHER_BASE.z };
      const f = fwdOf(0);
      const bx = base.x + f.x * 1.0;
      const bz = base.z + f.z * 1.0;
      const yaw = yawOf(b.x - bx, b.z - bz);
      const lpS = { ...STAND, p: [0, 0.95, 0] as P3 };
      localToRig({ x: bx, y: moundY(bx, bz), z: bz }, yaw, lpS, tmpA);
      localToRig(PITCHER_BASE, 0, lp2, tmpB);
      lerpRig(tmpB, tmpA, smooth((t - p.tHit - 0.3) / 0.6), this.pose);
    }
    this.pitcher.apply(this.pose);
  }

  private updateCatcherUmp(p: Play, t: number) {
    const up = smooth((t - p.tHit - 0.2) / 0.6);
    const cBase = { x: 0, y: 0, z: 0.8 };
    localToRig(cBase, Math.PI, CROUCH_C, tmpA);
    localToRig(cBase, Math.PI * 0.85, STAND, tmpB);
    lerpRig(tmpA, tmpB, up, this.pose);
    this.catcher.apply(this.pose);
    const uBase = { x: 0.05, y: 0, z: 1.45 };
    localToRig(uBase, Math.PI, CROUCH_U, tmpA);
    localToRig(uBase, Math.PI * 0.9, STAND, tmpB);
    lerpRig(tmpA, tmpB, up, this.pose);
    this.plateUmp.apply(this.pose);
  }

  private updateFielders(p: Play, t: number) {
    for (const id of ['3B', 'SS', '2B'] as const) {
      const f = this.fielders[id];
      if (id === p.fielder) this.activeFielder(p, t, f);
      else this.idleFielder(p, t, f, FIELDERS[id].pos, infieldTarget(p, id), true);
    }
  }

  // 打球に関わらない野手: 打った瞬間に小さく跳んで構え直し、ベースのカバーや打球の方へ動いてから、ボールを見る
  private idleFielder(p: Play, t: number, f: Figure, pos: { x: number; z: number }, target: { x: number; z: number } | null, hop: boolean) {
    const b = ballAt(p, t).pos;
    const yawHome = yawOf(-pos.x, -pos.z);
    const tGo = p.tHit + 0.25;
    const dx = target ? target.x - pos.x : 0;
    const dz = target ? target.z - pos.z : 0;
    const dist = Math.hypot(dx, dz);
    const dur = Math.max(0.5, dist / 5.5);
    const u = dist > 0.2 ? smooth((t - tGo) / dur) : 0;
    const here = { x: pos.x + dx * u, y: 0, z: pos.z + dz * u };
    const yawBall = t > p.tHit ? yawOf(b.x - here.x, b.z - here.z) : yawHome;
    const moving = dist > 0.2 && t > tGo && t < tGo + dur;
    if (moving) {
      const k = (t - tGo) / dur;
      const amp = clamp(dist / 3, 0.3, 1) * Math.sin(Math.PI * clamp(k, 0, 1)) ** 0.5;
      const yaw = angLerp(yawHome, yawOf(dx, dz), smooth(k / 0.25));
      localToRig(here, yaw, runLocal((dist * u) / 0.85 * Math.PI, amp), this.pose);
      if (k > 0.8) {
        localToRig(here, yawBall, STAND, tmpB);
        lerpRig(this.pose, tmpB, smooth((k - 0.8) / 0.2), this.pose);
      }
    } else {
      localToRig(here, yawHome, READY, tmpA);
      localToRig(here, yawBall, STAND, tmpB);
      const s0 = dist > 0.2 && t >= tGo + dur ? 1 : smooth((t - p.tHit - 0.4) / 0.6);
      lerpRig(tmpA, tmpB, s0, this.pose);
      if (hop) this.pose.pelvis.y += splitStep(p, t);
    }
    f.apply(this.pose);
  }

  private updateOutfield(p: Play, t: number) {
    const spots = [
      { x: -27, z: -62 },
      { x: 0, z: -76 },
      { x: 27, z: -62 },
    ];
    // 外野手は打球の方へ前進してカバーに入る（最大 5m）
    const G = p.ground.G;
    this.outfield.forEach((f, i) => {
      const s = spots[i];
      const dx = G.x - s.x;
      const dz = G.z - s.z;
      const d = Math.hypot(dx, dz);
      const go = Math.min(5, Math.max(0, d - 12));
      this.idleFielder(p, t, f, s, d > 0 ? { x: s.x + (dx / d) * go, z: s.z + (dz / d) * go } : null, false);
    });
  }

  // 打球を処理する野手
  private activeFielder(p: Play, t: number, f: Figure) {
    const fp = p.fp;
    const P0 = fp.id === 'P' ? { x: PITCHER_BASE.x, z: PITCHER_BASE.z + 1.0 } : fp.P0;
    const gy = (x: number, z: number) => (fp.id === 'P' ? moundY(x, z) : 0);
    const yawHome = yawOf(-P0.x, -P0.z);
    const tF = p.ground.tField;
    const tR = p.th.tRelease;
    // 遅いゴロ（投手ゴロも）は止まらずに突っ込み、走りながら捕る
    const slow = fp.kind === 'slow' || fp.id === 'P';
    const tArriveRun = tF - (slow ? 0.16 : 0.32);
    const pose = this.pose;
    if (t < tArriveRun) {
      const dist = Math.hypot(fp.Gbody.x - P0.x, fp.Gbody.z - P0.z);
      // 走る時間帯: ふつう・横の打球はすぐに全力で打球の正面へ入って構えて待つ。
      // 遅いゴロは一度構えてから、捕る瞬間に間に合うように全力で突っ込む（加速しながら）
      const runDur = Math.max(0.45, dist / (slow ? 5.0 : 5.5));
      const tRun1 = slow ? tArriveRun : Math.min(tArriveRun, fp.tMove + runDur);
      const tRun0 = slow ? Math.max(fp.tMove, tArriveRun - runDur) : fp.tMove;
      const k = clamp((t - tRun0) / Math.max(0.1, tRun1 - tRun0), 0, 1);
      const u = slow ? k * k * (2.2 - 1.2 * k) : smooth(k);
      const bx = P0.x + (fp.Gbody.x - P0.x) * u;
      const bz = P0.z + (fp.Gbody.z - P0.z) * u;
      const moving = t > tRun0 && t < tRun1 && dist > 0.4;
      const moveYaw = dist > 0.4 ? yawOf(fp.Gbody.x - P0.x, fp.Gbody.z - P0.z) : fp.faceField;
      // 走っている間は進む向き、着いたら打球の方（捕る向き）
      const yaw =
        t >= tRun1
          ? angLerp(dist > 1.5 ? moveYaw : fp.faceField, fp.faceField, smooth((t - tRun1) / 0.25))
          : angLerp(yawHome, dist > 1.5 ? moveYaw : fp.faceField, smooth((t - tRun0) / 0.25));
      const amp = moving ? clamp(dist / 3, 0.3, 1) * (slow && k > 0.5 ? 1 : Math.sin(Math.PI * k) ** 0.5) : 0;
      const lp = amp > 0.01 ? runLocal((dist * u) / 0.85 * Math.PI, amp) : READY;
      localToRig({ x: bx, y: gy(bx, bz), z: bz }, yaw, lp, pose);
      if (!moving || fp.id === 'P') {
        const lpR = fp.id === 'P' ? sampleKeys(PITCH_KEYS, Math.min(0.8, t - p.tPitch)) : READY;
        if (fp.id === 'P' && t < p.tHit + 0.5) {
          localToRig(PITCHER_BASE, 0, lpR, tmpA);
          lerpRig(tmpA, pose, smooth((t - p.tHit - 0.15) / 0.35), pose);
        } else if (!moving) {
          localToRig({ x: bx, y: gy(bx, bz), z: bz }, yaw, READY, pose);
          pose.pelvis.y += splitStep(p, t);
        }
      }
    } else if (t < tF) {
      // 捕球の構えへ
      this.activeFielder(p, tArriveRun - 1e-4, f);
      const a = clonePose(pose);
      localToRig({ x: fp.Gbody.x, y: gy(fp.Gbody.x, fp.Gbody.z), z: fp.Gbody.z }, fp.faceField, FIELD, tmpB);
      lerpRig(a, tmpB, smooth((t - tArriveRun) / (tF - tArriveRun - 0.04)), pose);
    } else {
      const fieldB = { x: fp.Gbody.x, y: gy(fp.Gbody.x, fp.Gbody.z), z: fp.Gbody.z };
      const throwB = { x: fp.throwBase.x, y: gy(fp.throwBase.x, fp.throwBase.z), z: fp.throwBase.z };
      const tG = tR + THROW_KEYS[0][0];
      if (t >= tG) {
        localToRig(throwB, fp.faceThrow, sampleKeys(THROW_KEYS, t - tR), pose);
      } else {
        // 起き上がって投げる向きへ
        const tRise = Math.min(tF + 0.28, tG - 0.05);
        localToRig(fieldB, fp.faceField, FIELD, tmpA);
        const midYaw = angLerp(fp.faceField, fp.faceThrow, 0.6);
        localToRig(fieldB, midYaw, RISE, tmpB);
        if (t < tRise) lerpRig(tmpA, tmpB, smooth((t - tF) / (tRise - tF)), pose);
        else {
          localToRig(throwB, fp.faceThrow, THROW_KEYS[0][1], tmpA);
          lerpRig(tmpB, tmpA, smooth((t - tRise) / Math.max(0.05, tG - tRise)), pose);
        }
      }
    }
    f.apply(pose);
  }

  private updateFirstBase(p: Play, t: number) {
    const f = this.firstBase;
    const fb = p.fb;
    const P0 = FIRST_BASEMAN_READY;
    const yawHome = yawOf(-P0.x, -P0.z);
    const yawThrow = yawOf(fb.dThrow.x, fb.dThrow.z);
    const tGo = p.tHit + 0.3;
    const dist = Math.hypot(BAG_CENTER.x - P0.x, BAG_CENTER.z - P0.z);
    const tSet = tGo + Math.max(0.9, dist / 6.5);
    const setPose = this.firstBaseSet(p, yawThrow, tmpB);
    if (t < tGo) {
      localToRig({ x: P0.x, y: 0, z: P0.z }, yawHome, READY, this.pose);
    } else if (t < tSet) {
      const u = smooth((t - tGo) / (tSet - tGo));
      const tx = BAG_CENTER.x + fb.dThrow.x * 0.25;
      const tz = BAG_CENTER.z + fb.dThrow.z * 0.25;
      const bx = P0.x + (tx - P0.x) * u;
      const bz = P0.z + (tz - P0.z) * u;
      const yaw = angLerp(yawOf(tx - P0.x, tz - P0.z), yawThrow, smooth((t - tGo - (tSet - tGo) * 0.6) / ((tSet - tGo) * 0.4)));
      localToRig({ x: bx, y: 0, z: bz }, yaw, runLocal((dist * u) / 0.85 * Math.PI, Math.sin(Math.PI * u) ** 0.6), this.pose);
      if (u > 0.75) lerpRig(this.pose, setPose, smooth((u - 0.75) / 0.25), this.pose);
    } else {
      const t1 = p.tCatch - 0.42;
      const t2 = p.tCatch - 0.07;
      const stretch = this.firstBaseStretch(p, yawThrow, tmpA);
      if (t < t1) copyPose(setPose, this.pose);
      else if (t < t2) lerpRig(setPose, stretch, smooth((t - t1) / (t2 - t1)), this.pose);
      else if (t < p.tCatch + 0.5) copyPose(stretch, this.pose);
      else {
        // 捕った後: 起き上がってボールを見せる
        const after = clonePose(setPose);
        after.lHand.set(after.pelvis.x + fwdOf(yawThrow).x * 0.2, after.pelvis.y + 0.75, after.pelvis.z + fwdOf(yawThrow).z * 0.2);
        lerpRig(stretch, after, smooth((t - p.tCatch - 0.5) / 0.7), this.pose);
      }
    }
    f.apply(this.pose);
    if (t <= p.tCatch + 0.05) this.catchOffset.subVectors(new V(fb.C.x, fb.C.y, fb.C.z), f.j.lHand);
  }

  // ベースに着いて構える（右足をベース、グラブを胸の前に）
  private firstBaseSet(p: Play, yaw: number, out: RigPose) {
    const fb = p.fb;
    const fw = fwdOf(yaw);
    const rt = rightOf(yaw);
    out.yaw = yaw;
    out.rFoot.set(fb.anchor.x, fb.anchor.y, fb.anchor.z);
    out.lFoot.set(BAG_CENTER.x + fw.x * 0.42 - rt.x * 0.22, ANKLE_H, BAG_CENTER.z + fw.z * 0.42 - rt.z * 0.22);
    out.pelvis.set((out.rFoot.x + out.lFoot.x) / 2, 0.9, (out.rFoot.z + out.lFoot.z) / 2);
    out.lean = 0.15;
    out.side = 0;
    out.twist = 0;
    out.headYaw = 0;
    out.headPitch = 0;
    out.lFootYaw = yaw - 0.3;
    out.rFootYaw = yaw + 0.6;
    out.lToe = 0;
    out.rToe = 0;
    out.lHand.set(out.pelvis.x + fw.x * 0.42 - rt.x * 0.12, 1.45, out.pelvis.z + fw.z * 0.42 - rt.z * 0.12);
    out.rHand.set(out.pelvis.x + fw.x * 0.35 + rt.x * 0.12, 1.35, out.pelvis.z + fw.z * 0.35 + rt.z * 0.12);
    out.lElbowPole = new V(-rt.x, -0.6, -rt.z);
    out.rElbowPole = null;
    out.bat = null;
    out.gloveDir = new V(fw.x, 0.1, fw.z);
    return out;
  }

  // 送球の方へ伸びる。グラブは捕球点 C にぴったり合わせる
  private firstBaseStretch(p: Play, yawThrow: number, out: RigPose) {
    const fb = p.fb;
    const C = new V(fb.C.x, fb.C.y, fb.C.z);
    const A = new V(fb.anchor.x, fb.anchor.y, fb.anchor.z);
    const S = new V(fb.stride.x, fb.stride.y, fb.stride.z);
    const yaw = yawOf(C.x - A.x, C.z - A.z);
    out.yaw = angLerp(yawThrow, yaw, 0.6);
    out.rFoot.copy(A);
    out.lFoot.copy(S);
    out.lFootYaw = out.yaw - 0.2;
    out.rFootYaw = out.yaw + 1.0;
    out.lToe = 0;
    out.rToe = 0;
    out.twist = 0;
    out.side = 0;
    out.headYaw = 0;
    out.headPitch = 0;
    out.bat = null;
    // 腰: 両足の間からグラブ側へ。届くまで前に傾け、それでも届かなければ腰を寄せる
    const mid = new V().addVectors(A, S).multiplyScalar(0.5);
    const toC = new V(C.x - mid.x, 0, C.z - mid.z);
    const lowC = C.y < 0.8 ? (0.8 - C.y) * 0.5 : 0;
    out.pelvis.set(mid.x + toC.x * 0.15, 0.78 - lowC, mid.z + toC.z * 0.15);
    const sh = new V();
    const reach = 0.54;
    let lean = 0.15;
    for (let i = 0; i < 24; i++) {
      out.lean = lean;
      this.firstBase.shoulder(out, 'L', sh);
      if (sh.distanceTo(C) <= reach) break;
      lean += 0.05;
      if (lean > 1.1) {
        // 腰を捕球点の方へ
        const d = new V(C.x - sh.x, 0, C.z - sh.z);
        const over = sh.distanceTo(C) - reach;
        d.normalize().multiplyScalar(Math.min(0.05, over));
        out.pelvis.add(d);
        out.pelvis.y = Math.max(0.55, out.pelvis.y - 0.02);
        lean = 1.1;
      }
    }
    out.lHand.copy(C);
    const fw = fwdOf(out.yaw);
    const rt = rightOf(out.yaw);
    out.rHand.set(out.pelvis.x - fw.x * 0.1 + rt.x * 0.35, out.pelvis.y + 0.2, out.pelvis.z - fw.z * 0.1 + rt.z * 0.35);
    out.lElbowPole = new V(-rt.x, -0.8, -rt.z);
    out.rElbowPole = null;
    // グラブの面は送球の来る方へ
    const R0 = p.th.R;
    out.gloveDir = new V(R0.x - C.x, (R0.y - C.y) * 0.3, R0.z - C.z).normalize();
    return out;
  }

  // 一塁手の捕球点（見た目の検算用）
  firstBaseGlove(out: V3) {
    return out.copy(this.firstBase.j.lHand);
  }

  // ---- 監督 ----
  managerIdle() {
    for (const side of ['home', 'away'] as const) {
      if (this.requesting === side) continue;
      const d = this.dugouts[side];
      const fw = fwdOf(d.yaw);
      localToRig({ x: d.pos.x - fw.x * 0.35, y: 0, z: d.pos.z - fw.z * 0.35 }, d.yaw, RAIL, this.pose);
      this.managers[side].apply(this.pose);
    }
  }
  requesting: 'home' | 'away' | null = null;

  // リクエストの仕草（c: 経過時間）。手の位置を返す（四角の軌跡を描くため）
  managerRequest(side: 'home' | 'away', c: number) {
    this.requesting = side;
    const d = this.dugouts[side];
    const fw = fwdOf(d.yaw);
    // ベンチの奥から前へ歩いて出てくる
    const u = smooth(c / 0.9);
    const from = { x: d.back.x, z: d.back.z };
    const to = { x: d.pos.x + fw.x * 1.2, z: d.pos.z + fw.z * 1.2 };
    const bx = from.x + (to.x - from.x) * u;
    const bz = from.z + (to.z - from.z) * u;
    if (c < 0.9) {
      const dist = Math.hypot(to.x - from.x, to.z - from.z);
      localToRig({ x: bx, y: 0, z: bz }, d.yaw, runLocal((dist * u) / 0.7 * Math.PI, 0.45), this.pose);
    } else localToRig({ x: bx, y: 0, z: bz }, d.yaw, sampleKeys(REQ_KEYS, c), this.pose);
    this.pose.lElbowPole = new V(-rightOf(d.yaw).x, -0.3, -rightOf(d.yaw).z);
    this.pose.rElbowPole = new V(rightOf(d.yaw).x, -0.3, rightOf(d.yaw).z);
    const m = this.managers[side];
    m.apply(this.pose);
    return { l: m.j.lHand.clone(), r: m.j.rHand.clone(), head: m.j.head.clone() };
  }
  endRequest() {
    this.requesting = null;
  }
}

function clonePose(a: RigPose): RigPose {
  const o = newPose();
  return copyPose(a, o);
}
function copyPose(a: RigPose, o: RigPose): RigPose {
  return lerpRig(a, a, 0, o);
}
