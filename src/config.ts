// 調整値をまとめる。単位は m・秒。
// 座標: 本塁が原点、y が上。一塁は +x・-z 方向、投手は -z 方向。

export type Vec3 = { x: number; y: number; z: number };

export const BASE_DIST = 27.43; // 塁間
export const BAG_SIZE = 0.381; // ベースの一辺
export const BAG_HEIGHT = 0.08;
export const BAG_FRONT_S = BASE_DIST - BAG_SIZE; // 本塁側のベースの縁（一塁線に沿った距離）

// 一塁線の向き（本塁 → 一塁）と、フェア側（二塁側）に向かう向き
export const U = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
export const F = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };

// 一塁線に沿った距離 s と、線からフェア側への距離 l を世界座標に直す
export function lineToWorld(s: number, l: number, y = 0): Vec3 {
  return { x: U.x * s + F.x * l, y, z: U.z * s + F.z * l };
}
export function worldToLine(p: { x: number; z: number }) {
  return { s: p.x * U.x + p.z * U.z, l: p.x * F.x + p.z * F.z };
}

export const BAG_CENTER = lineToWorld(BASE_DIST - BAG_SIZE / 2, BAG_SIZE / 2);
export const MOUND = { x: 0, z: -18.44 };
export const MOUND_HEIGHT = 0.25;
// マウンドの高さ（上面の半径 0.9m、裾の半径 2.74m）
export function moundY(x: number, z: number) {
  const r = Math.hypot(x - MOUND.x, z - MOUND.z);
  if (r <= 0.9) return MOUND_HEIGHT;
  if (r >= 2.74) return 0;
  return MOUND_HEIGHT * (2.74 - r) / 1.84;
}

export const GAME = {
  maxMisses: 3,
  decisionWindow: 2.0, // 両方が起きてから判定できる時間
  pitchStart: 0.0,
  tHit: 1.55, // プレー開始から打つまで
  callDisplay: 1.0,
  resultDisplay: 1.3,
  replaySkipGuard: 0.4,
};

// 段階（何プレー目から）
export const STAGE = {
  tutorial: 3, // 最初の3プレーは明らかなタイミングだけ
  lefty: 8, // 左打者が出る
  wideThrow: 15, // 送球がそれて一塁手が大きく伸びる
};

// 得点（「球審ジャッジ」と同じ形）: 正解 100 点、際どいプレーの正解 300 点、早押しボーナス
export const SCORE = {
  correct: 100,
  closeCorrect: 300,
  // 早押しボーナス: 足とボールの両方が起きてからコールまでの秒数がこの値以内ならその点数
  speedBonus: [
    { within: 0.7, points: 20 },
    { within: 1.0, points: 10 },
  ],
};

// 段階: そのゲームでここまでに正しく判定できた数（練習を含む）で決まる。
//   title: 結果画面の称号（最後の正解数で決まる）
//   close: [いちばん小さい差, 際どいとする差]（秒）。
//          1つめより小さい差のプレーは出さない。差が2つめ以下なら「際どいプレー」と判定し、必ずリクエスト・リプレイになる
//   rate: 際どいプレーが出る確率（練習の3プレーを除く）
export const LEVELS = [
  { min: 0, title: '草野球の審判', close: [0.03, 0.05], rate: 0.4 },
  { min: 10, title: '審判見習い', close: [0.02, 0.04], rate: 0.5 },
  { min: 20, title: '二軍の審判', close: [0.01, 0.03], rate: 0.5 },
  { min: 30, title: '一軍の審判', close: [0.005, 0.02], rate: 0.6 },
  { min: 40, title: '名審判', close: [0.001, 0.015], rate: 0.6 },
  { min: 50, title: '神審判', close: [0.001, 0.01], rate: 0.6 },
  { min: 100, title: 'AI審判', close: [0.001, 0.01], rate: 0.6 },
] as const;

export function levelOf(correct: number) {
  let lv: (typeof LEVELS)[number] = LEVELS[0];
  for (const l of LEVELS) if (correct >= l.min) lv = l;
  return lv;
}

// 難易度: 正解数から、差（秒）の選び方を決める
export function difficulty(correct: number) {
  const lv = levelOf(correct);
  const [closeMin, closeMax] = lv.close;
  return {
    pClose: lv.rate,
    pMedium: 0.35,
    closeMin, // これより小さい差は出さない
    closeMax, // これ以下の差は「際どい」
    // 際どくないプレー: 中くらいは「際どい」の境目のすぐ上から 0.06 秒の幅、はっきりはその上（0.10 秒以上、幅 0.2 秒）
    mediumMin: closeMax + 0.001,
    mediumMax: closeMax + 0.06,
    clearMin: Math.max(0.1, closeMax + 0.06),
    clearWidth: 0.2,
  };
}

export const RUNNER = {
  startDelay: 0.32, // 打ってから走り出すまで
  topSpeedR: [7.9, 8.6] as [number, number], // 右打者の最高速度
  topSpeedL: [8.2, 8.9] as [number, number],
  accelTau: 0.8,
  footAheadFrac: 0.15, // 着地の瞬間、足は腰より（歩幅 × この値）前にある
  liftFrac: 0.22, // 腰が着地点を（歩幅 × この値）越えたら足が離れる
  touchFootS: BAG_FRONT_S + 0.14, // ベースを踏む足の中心
  touchFootL: 0.06,
  laneL: -0.32, // 走路（ファウル側）
  stopDecel: 3.2,
};

export const FIELDERS = {
  P: { name: '投手', pos: { x: 0.4, z: -16.0 }, throwSpeed: [22, 27] as [number, number] },
  '3B': { name: '三塁手', pos: { x: -19.5, z: -24.5 }, throwSpeed: [34, 39] as [number, number] },
  SS: { name: '遊撃手', pos: { x: -8.5, z: -32.5 }, throwSpeed: [32, 37] as [number, number] },
  '2B': { name: '二塁手', pos: { x: 8.5, z: -33 }, throwSpeed: [25, 30] as [number, number] },
};
export type FielderId = keyof typeof FIELDERS;

export const FIRST_BASEMAN_READY = { x: 21.6, z: -25.2 };

export const CAMERA = {
  fov: 40, // 判定のときの画角（縦）。小さいほどミットとベースが大きく映る
  eyeY: 1.75,
  dist: 5.4, // 判定位置でのベースからの距離
  judgeAngle: [0.2, 0.45] as [number, number], // 判定位置の向き（ベースから見て一塁線の先からフェア側へ回る角度、ラジアン）
  judgeLookUp: 0.0, // 判定のとき見る点を、足とミットの真ん中からどれだけ上げるか
  homeLookY: 1.0,
};
