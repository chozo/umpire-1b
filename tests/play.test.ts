import { describe, expect, it } from 'vitest';
import { BAG_FRONT_S, BAG_HEIGHT, BASE_DIST, LEVELS, RUNNER, STAGE, difficulty } from '../src/config';
import { ANKLE_H, ballAt, generatePlay, mulberry32, runnerS, runnerTimeAtS, throwPos } from '../src/play';

describe('generatePlay', () => {
  it('多くの乱数で必ずプレーを作れて、条件を満たす', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 40; i++) {
        const p = generatePlay(rng, i);
        // 判定と差が一致し、同時はない
        expect(p.out).toBe(p.margin > 0);
        expect(Math.abs(p.margin)).toBeGreaterThanOrEqual(0.001);
        expect(p.tArrive - p.tCatch).toBeCloseTo(p.margin, 9);
        // 順番: 打つ → 捕る → 投げる → 捕る
        expect(p.ground.tField).toBeGreaterThan(p.tHit + 0.4);
        expect(p.th.tRelease).toBeGreaterThan(p.ground.tField);
        expect(p.th.tCatch).toBeGreaterThan(p.th.tRelease);
        // 打球の平均速度が現実的
        const gd = Math.hypot(p.ground.G.x - p.ground.H.x, p.ground.G.z - p.ground.H.z);
        const avg = gd / (p.ground.tField - p.tHit);
        expect(avg).toBeGreaterThan(4.9);
        expect(avg).toBeLessThan(52);
        // 練習のプレーは明らかな差
        if (i < STAGE.tutorial) expect(Math.abs(p.margin)).toBeGreaterThanOrEqual(0.3);
      }
    }
  });

  it('走者の一塁到達は 3.8〜4.6 秒（打ってから）', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = generatePlay(mulberry32(seed), 10);
      const t = p.tArrive - p.tHit;
      expect(t).toBeGreaterThan(3.8);
      expect(t).toBeLessThan(4.6);
    }
  });

  it('ベースを踏む一歩: 着地の時刻が到達時刻で、足はベースの上', () => {
    const p = generatePlay(mulberry32(7), 12);
    const r = p.runner;
    const touch = r.plants[r.touchIndex];
    expect(touch.t).toBe(r.tArrive);
    expect(touch.onBag).toBe(true);
    expect(touch.foot).toBe('L');
    expect(touch.y).toBeCloseTo(BAG_HEIGHT + ANKLE_H);
    expect(touch.s).toBeGreaterThan(BAG_FRONT_S);
    expect(touch.s).toBeLessThan(BASE_DIST);
    // ほかの一歩はベースに乗らない
    r.plants.forEach((pl, k) => {
      if (k !== r.touchIndex) expect(pl.s < BAG_FRONT_S - 0.1 || pl.s > BASE_DIST + 0.1).toBe(true);
    });
    // 着地は時刻順・左右交互
    for (let k = 1; k < r.plants.length; k++) {
      expect(r.plants[k].t).toBeGreaterThan(r.plants[k - 1].t);
      expect(r.plants[k].foot).not.toBe(r.plants[k - 1].foot);
    }
    // 腰の位置と時刻の変換が逆関数になっている
    for (const t of [r.tStart + 0.5, r.tArrive - 0.01, r.tArrive + 0.4]) {
      expect(runnerTimeAtS(r, runnerS(r, t))).toBeCloseTo(t, 4);
    }
    expect(runnerS(r, r.tArrive)).toBeCloseTo(r.sTouch, 6);
    expect(r.sTouch).toBeCloseTo(RUNNER.touchFootS - RUNNER.footAheadFrac * touch.len, 9);
  });

  it('送球は捕球の時刻にミットの位置へ着く', () => {
    const p = generatePlay(mulberry32(3), 20);
    const c = throwPos(p.th, p.th.tCatch);
    expect(c.x).toBeCloseTo(p.th.C.x);
    expect(c.y).toBeCloseTo(p.th.C.y);
    expect(c.z).toBeCloseTo(p.th.C.z);
    expect(ballAt(p, p.tCatch + 0.001).phase).toBe('caught');
    expect(ballAt(p, p.tCatch - 0.001).phase).toBe('throw');
  });

  it('指定した差・アウト/セーフで作れる', () => {
    const rng = mulberry32(5);
    for (const m of [0.004, -0.004, 0.012, -0.03, 0.4, -0.45]) {
      const p = generatePlay(rng, 10, { margin: m });
      expect(p.margin).toBe(m);
      expect(p.close).toBe(Math.abs(m) <= difficulty(10).closeMax);
    }
    for (const f of ['P', '3B', 'SS', '2B'] as const) {
      for (const out of [true, false]) {
        const p = generatePlay(rng, 30, { fielder: f, category: 'close', out });
        expect(p.fielder).toBe(f);
        expect(p.out).toBe(out);
      }
    }
  });

  it('際どいプレーの割合が段階とともに増える', () => {
    const rate = (i: number) => {
      const rng = mulberry32(99);
      let n = 0;
      for (let k = 0; k < 400; k++) if (generatePlay(rng, i).close) n++;
      return n / 400;
    };
    expect(rate(5)).toBeLessThan(rate(30));
  });

  it('正解数の段階ごとに、際どい差の範囲と割合が表どおり', () => {
    for (const lv of LEVELS) {
      for (const correct of [lv.min, lv.min + 5]) {
        const rng = mulberry32(1000 + correct);
        let nearOver = 0; // 「際どい」の境目のすぐ上（0.03 秒以内）の際どくないプレー
        let n = 0;
        let total = 0;
        const d = difficulty(correct);
        for (let k = 0; k < 1500; k++) {
          const p = generatePlay(rng, STAGE.tutorial + (k % 30), {}, correct);
          const a = Math.abs(p.margin);
          total++;
          // いちばん小さい差より際どいプレーは出ない。際どいかどうかは差が境目以下かどうか
          expect(a).toBeGreaterThanOrEqual(lv.close[0] - 1e-12);
          expect(p.close).toBe(a <= lv.close[1]);
          if (p.close) n++;
          else if (a < d.closeMax + 0.03) nearOver++;
          // 際どくないプレーは、はっきりでも 0.10 秒〜境目 + 0.26 秒まで（以前より縮めた）
          if (!p.close) expect(a).toBeLessThanOrEqual(Math.max(0.1, d.closeMax + 0.06) + 0.2 + 1e-12);
        }
        expect(nearOver).toBeGreaterThan(0); // 境目のすぐ上のプレーも出る
        expect(n / total).toBeGreaterThan(lv.rate - 0.04);
        expect(n / total).toBeLessThan(lv.rate + 0.04);
      }
    }
  });

  it('打球の種類: ふつう・横（三遊間・二遊間など）・遅いゴロ（前に突っ込む）が出る', () => {
    const rng = mulberry32(77);
    const n = { routine: 0, side: 0, slow: 0 };
    for (let k = 0; k < 600; k++) {
      const p = generatePlay(rng, STAGE.tutorial + (k % 30));
      n[p.fp.kind]++;
      const g = p.ground;
      const v = Math.hypot(g.G.x - g.H.x, g.G.z - g.H.z) / (g.tField - g.tHit);
      const P0 = p.fp.P0;
      const toHome = Math.hypot(P0.x, P0.z) - Math.hypot(p.fp.Gbody.x, p.fp.Gbody.z); // 本塁へ近づいた距離
      if (p.fp.kind === 'slow') {
        expect(v).toBeLessThanOrEqual(16 + 3 * 5 + 1e-9);
        expect(toHome).toBeGreaterThan(1.5);
      }
      if (p.fp.kind === 'side') expect(Math.hypot(p.fp.Gbody.x - P0.x, p.fp.Gbody.z - P0.z)).toBeGreaterThan(2);
    }
    expect(n.routine).toBeGreaterThan(60);
    expect(n.side).toBeGreaterThan(60);
    expect(n.slow).toBeGreaterThan(60);
  });

  it('段階の境目', () => {
    expect(difficulty(9).closeMax).toBe(0.05);
    expect(difficulty(10).closeMax).toBe(0.04);
    expect(difficulty(39).closeMin).toBe(0.005);
    expect(difficulty(40).closeMin).toBe(0.001);
    expect(difficulty(49).closeMax).toBe(0.015);
    expect(difficulty(50).closeMax).toBe(0.01);
    expect(difficulty(100).closeMax).toBe(0.01);
    expect(difficulty(99).pClose).toBe(0.6);
    expect(difficulty(0).pClose).toBe(0.4);
    expect(difficulty(10).pClose).toBe(0.5);
  });
});
