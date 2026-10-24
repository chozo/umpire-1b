import * as THREE from 'three';
import { BAG_CENTER, CAMERA, F, U, lineToWorld, worldToLine } from './config';
import { ballAt, fwdOf, type Play } from './play';
import type { Dugout } from './actors';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (u: number) => {
  const k = clamp(u, 0, 1);
  return k * k * (3 - 2 * k);
};
const V = THREE.Vector3;

// 塁審の立ち位置: 一塁ベースの後ろ（ファウル側）から、送球に対して直角に近い位置へ動く
export function umpireSpots(p: Play) {
  const S0 = lineToWorld(30.6, -3.4, CAMERA.eyeY);
  const R = p.th.R;
  const dx = BAG_CENTER.x - R.x;
  const dz = BAG_CENTER.z - R.z;
  const d = Math.hypot(dx, dz);
  const ds = (dx * U.x + dz * U.z) / d;
  const dl = (dx * F.x + dz * F.z) / d;
  // 送球に直角な向き（ベースの先の側）
  let ps = dl;
  let pl = -ds;
  if (ps < 0) {
    ps = -ps;
    pl = -pl;
  }
  const th = clamp(Math.atan2(pl, ps), CAMERA.judgeAngle[0], CAMERA.judgeAngle[1]);
  const bag = worldToLine(BAG_CENTER);
  const S1 = lineToWorld(bag.s + CAMERA.dist * Math.cos(th), bag.l + CAMERA.dist * Math.sin(th), CAMERA.eyeY);
  // 判定のときに見る点: ベースを踏む足と捕球点（ミット）の真ん中。高い送球でもミットが画面の端に寄らない
  const C = p.fb.C;
  const J = new V(
    (BAG_CENTER.x + C.x) / 2 - U.x * 0.4,
    (0.1 + C.y) / 2 + CAMERA.judgeLookUp,
    (BAG_CENTER.z + C.z) / 2 - U.z * 0.4,
  );
  return { S0: new V(S0.x, S0.y, S0.z), S1: new V(S1.x, S1.y, S1.z), J };
}

const LOOK_PRE = new V(-0.3, 1.0, 0.2);

// 塁審の目線（時刻 t の関数。リプレイでも同じ動きになる）
export function umpireCamAt(p: Play, t: number, cam: THREE.PerspectiveCamera, spots = umpireSpots(p)) {
  const move = smooth((t - p.tHit - 0.15) / 1.4);
  cam.position.lerpVectors(spots.S0, spots.S1, move);
  // 打球を少し遅れて追う
  const lag = new V();
  for (let k = 1; k <= 5; k++) {
    const b = ballAt(p, t - k * 0.05).pos;
    lag.x += b.x / 5;
    lag.y += b.y / 5;
    lag.z += b.z / 5;
  }
  lag.y = Math.max(lag.y, 0.6);
  const hit = smooth((t - p.tHit - 0.05) / 0.35);
  // 送球が来る前に、ベースとミットの方へ向き直る（短い送球でも捕球の0.6秒前には向いている）
  const tTurn = Math.min(p.th.tRelease - 0.1, p.tCatch - 1.0);
  const toJ = smooth((t - tTurn) / 0.4);
  const look = new V().lerpVectors(LOOK_PRE, lag, hit).lerp(spots.J, toJ);
  cam.lookAt(look);
  cam.fov = 30 + 14 * hit + (CAMERA.fov - 44) * toJ;
  cam.updateProjectionMatrix();
}

// リプレイ: 足とベースを横から（ファウル側の低い位置）
export function footCam(p: Play, cam: THREE.PerspectiveCamera) {
  const touch = p.runner.plants[p.runner.touchIndex];
  const pos = lineToWorld(touch.s - 0.3, -2.5, 0.55);
  const look = lineToWorld(touch.s - 0.1, 0.12, 0.22);
  cam.position.set(pos.x, pos.y, pos.z);
  cam.lookAt(look.x, look.y, look.z);
  cam.fov = 34;
  cam.updateProjectionMatrix();
}

// リプレイ: ミットを横から（送球に直角、ベースの先の側）
export function mittCam(p: Play, cam: THREE.PerspectiveCamera) {
  const C = p.fb.C;
  const dt = p.fb.dThrow;
  let px = -dt.z;
  let pz = dt.x;
  if (px * U.x + pz * U.z < 0) {
    px = -px;
    pz = -pz;
  }
  // 送球の来る側へ少し回り込み、グラブの網とボールが見える角度にする
  cam.position.set(C.x + px * 1.9 + dt.x * 1.0, C.y + 0.3, C.z + pz * 1.9 + dt.z * 1.0);
  cam.lookAt(C.x + dt.x * 0.3, C.y - 0.05, C.z + dt.z * 0.3);
  cam.fov = 32;
  cam.updateProjectionMatrix();
}

// 監督のアップ（c: 演出の経過時間）
export function managerCam(d: Dugout, c: number, cam: THREE.PerspectiveCamera) {
  const fw = fwdOf(d.yaw);
  const front = { x: d.pos.x + fw.x * 1.2, z: d.pos.z + fw.z * 1.2 };
  const dist = 5.4 - 1.2 * smooth(c / 2.4);
  // 少し斜めから
  const side = { x: -fw.z, z: fw.x };
  cam.position.set(front.x + fw.x * dist + side.x * 1.0, 1.45, front.z + fw.z * dist + side.z * 1.0);
  cam.lookAt(front.x, 1.3, front.z);
  cam.fov = 38;
  cam.updateProjectionMatrix();
}
