// 一塁塁審ジャッジの告知動画の台本（縦型・約30秒）。npm run promo で撮影から MP4 まで作る。
// 流れ: つかみ（0.03 秒差のスーパースロー）→ タイトル → ふつうのプレーで「セーフ！」→ 際どいプレーで
//       「アウト！」→ 監督のリクエスト → スーパースロー → ナイスジャッジ！ → 締めの一言 → エンドカード。
// 称号の名前（とくに上のほう）はシークレットなので、動画には出さない。
// 際どいプレーはわざと 0.03 秒前後にする（遊ぶと、もっと厳しい差を判定させられる理不尽さを楽しんでもらう）。
// 使える操作はスキルの references/scenario-api.md。

export const config = {
  slug: 'umpire-1b',
  url: 'https://game.chozo.net/umpire-1b/',
  orientation: 'portrait',
  game: { width: 360, height: 640 }, // 9:16
  serveDir: 'dist', // npm run build の出力（dist/umpire-1b/）
  gamePath: '/umpire-1b/',
  gameQuery: 'promo=1&seed=5', // ゲームは自分の乱数を使うので、種は URL で固定する
  layout: { centerX: 0.5, centerY: 0.48, maxW: 0.9, maxH: 0.86 }, // 真ん中に大きく
  music: false, // BGM はゲームの応援風の曲（__game.audio が鳴らし直す）
};

const CAP = { y: 0.19, size: 50 }; // 早送りの表示（上 10%）と重ならない高さ

/** 撮らずに、条件を満たすまでゲームを進める。撮らない間の音の指示は捨てられるので、BGM の状態を記録し直す */
async function skipUntil(p, cond, max = 30) {
  const r = await p.until(cond, { max, record: false });
  await p.call('audio.resync');
  return r;
}

/** 次のプレーを指定して始め、打つ少し前まで撮らずに進める */
async function nextPlay(p, force) {
  await p.call('replay', force);
  const s = await p.state();
  await skipUntil(p, (x) => x.t >= s.play.tHit - 0.5);
  return s.play;
}

/** コールできるようになったら正しくコールする（delay 秒待ってから） */
async function callTruth(p, play, delay = 0.3) {
  await p.until((s) => s.armed, { max: 8 });
  if (delay > 0) await p.wait(delay);
  await p.call('call', play.out ? 'out' : 'safe');
}

export default async function scenario(p) {
  await p.call('manual', true);
  await p.call('start');

  // ---- 0〜2.5秒: つかみ。0.03 秒差をスーパースローで ----
  let play = await nextPlay(p, { margin: 0.03, fielder: 'SS' });
  await skipUntil(p, (s) => s.armed);
  await p.call('call', 'out');
  await skipUntil(p, (s) => s.phase === 'replay' && s.replaySub === 'r2');
  await skipUntil(p, (s) => s.rt >= Math.min(s.play.tCatch, s.play.tArrive) - 0.03);
  p.caption('どっちが先！？', { ...CAP, size: 60, dur: 2.4 });
  let stamps = 0;
  p.on('stamp', () => {
    stamps++;
    p.flash({ dur: 0.15, strength: 0.4 });
  });
  await p.until(() => stamps >= 2, { max: 4 });
  p.fx('0.03秒差！', { x: 0.5, y: 0.47, rot: -6, size: 58, dur: 1.0 });
  await p.wait(0.8);
  p.off('stamp');

  // ---- 2.5〜5.5秒: タイトル（後ろは次のプレーの投球前。ほぼ止めておく） ----
  await p.call('replay', { margin: -0.12, fielder: '3B' });
  play = (await p.state()).play;
  p.speed(0.1, { badge: false });
  p.title({ title: '一塁塁審\nジャッジ', sub: '足が先か、ボールが先か。', dur: 2.8 });
  await p.wait(2.9);
  p.speed(1);

  // ---- 5.5〜11秒: ふつうのプレー。内野ゴロ → セーフ！ ----
  await skipUntil(p, (x) => x.t >= play.tHit - 0.5);
  p.caption('内野ゴロ！', { ...CAP, dur: 1.4 });
  await p.wait(1.1);
  p.speed(2.6); // 打球と送球の間は早送り
  await p.until((s) => s.t >= s.play.tRelease - 0.15, { max: 4 });
  p.speed(1);
  p.caption('足が先？\nボールが先？', { ...CAP, dur: 1.6 });
  await callTruth(p, play, 0.25);
  await p.wait(1.4);

  // ---- 11〜22秒: 際どいプレー。アウト！ → リクエスト → スーパースロー → ナイスジャッジ！ ----
  play = await nextPlay(p, { margin: 0.027, fielder: 'SS' });
  await p.wait(0.5);
  p.speed(2.6);
  await p.until((s) => s.t >= s.play.tRelease - 0.15, { max: 4 });
  p.speed(1);
  await callTruth(p, play, 0.2);
  await p.until((s) => s.phase === 'request', { max: 3 });
  p.caption('監督がリクエスト！', { ...CAP, y: 0.66, dur: 1.5 });
  p.speed(2, { badge: false });
  await p.until((s) => s.phase === 'replay', { max: 3 });
  p.caption('スロー映像で検証！', { ...CAP, dur: 1.4 });
  p.speed(2.6, { badge: false });
  await p.until((s) => s.replaySub === 'r2', { max: 5 });
  p.speed(2.6, { badge: false }); // スーパースローは足とミットの瞬間で止まるので、そのほかは早める
  stamps = 0;
  p.on('stamp', () => {
    stamps++;
    p.flash({ dur: 0.15, strength: 0.4 });
  });
  await p.until((s) => s.replaySub === 'r3', { max: 8 });
  p.speed(1);
  p.off('stamp');
  p.fx('ナイスジャッジ！', { x: 0.5, y: 0.2, rot: -5, size: 64, dur: 1.4, color: '#fde047' });
  p.shake(6, 0.4);
  await p.wait(1.8);

  // ---- 22〜26秒: 締めの一言 ----
  play = await nextPlay(p, { margin: -0.03, fielder: '2B' });
  p.caption('正解するほど\n際どくなる！', { ...CAP, dur: 1.4 });
  p.speed(2.6, { badge: false });
  await p.wait(1.5);
  p.speed(1);
  p.caption('きみの目で\n見極めろ！', { ...CAP, size: 60, dur: 1.6 });
  await p.wait(1.6);

  // ---- 26〜29.5秒: エンドカード ----
  p.endCard({ title: '一塁塁審\nジャッジ', sub: '足が先か、ボールが先か。', cta: '今すぐ遊べる！', dur: 3.3 });
  await p.wait(3.3);
}
