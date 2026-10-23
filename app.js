'use strict';

// ---------- 音の生成 ----------
// 音声ファイルを持たず、その場でWAVを合成する。
// <audio>要素で鳴らすのは、iOSでサイレントスイッチを無視でき、画面ロック中も再生が続きやすいため。

const SR = 22050;

function toWavUrl(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const sq = (phase) => (Math.sin(phase) >= 0 ? 1 : -1);
const tri = (x) => 1 - Math.abs(((x % 1) + 1) % 1 * 2 - 1); // 0→1→0

// 音割れ寸前まで持ち上げて、体感音量を最大にする
const loud = (s) => Math.max(-1, Math.min(1, s * 2.2));

function synth(kind) {
  const seconds = kind === 'beep' ? 1 : 2.4;
  const out = new Float32Array(Math.round(SR * seconds));
  let p1 = 0, p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let s = 0;
    if (kind === 'siren') {
      const f = 650 + 1250 * tri(t / 1.2);
      p1 += 2 * Math.PI * f / SR;
      p2 += 2 * Math.PI * f * 1.5 / SR;
      s = 0.6 * sq(p1) + 0.4 * sq(p2);
    } else if (kind === 'beep') {
      const local = t % 1;
      const on = local < 0.6 && (local % 0.15) < 0.1;
      p1 += 2 * Math.PI * 2900 / SR;
      p2 += 2 * Math.PI * 3150 / SR;
      s = on ? 0.55 * sq(p1) + 0.45 * sq(p2) : 0;
    } else {
      // chaos: 速いサイレン + 高音ビープ + ノイズを交互に
      const f = 900 + 1600 * tri(t / 0.3);
      p1 += 2 * Math.PI * f / SR;
      p2 += 2 * Math.PI * (t % 0.4 < 0.2 ? 3300 : 220) / SR;
      const noise = (t % 0.8 > 0.6) ? (Math.random() * 2 - 1) : 0;
      s = 0.5 * sq(p1) + 0.35 * sq(p2) + 0.5 * noise;
    }
    out[i] = loud(s);
  }
  return toWavUrl(out, SR);
}

const sounds = {};
const soundUrl = (kind) => (sounds[kind] ||= synth(kind));
// 待機中に流し続ける無音。再生を続けることでiOSにページを止められにくくする
const silentUrl = toWavUrl(new Float32Array(8000), 8000);

// ---------- 状態 ----------

const $ = (id) => document.getElementById(id);
const app = $('app');
const player = $('player');
const STORE_KEY = 'bakuon-alarm';
const HOLD_MS = 3000;

let state = 'idle'; // idle | armed | ringing | resume
let target = 0;     // アラーム時刻(ms)
let wakeLock = null;
let testTimer = 0;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function save(patch) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...load(), ...patch })); } catch { /* 保存できなくても動かす */ }
}

const selectedSound = () => document.querySelector('input[name="sound"]:checked').value;

function setState(next) {
  state = next;
  app.dataset.state = next;
  document.body.dataset.state = next;
  $('setup').hidden = next !== 'idle';
  $('armed').hidden = next !== 'armed';
  $('ringing').hidden = next !== 'ringing';
  $('resume').hidden = next !== 'resume';
  if (next !== 'ringing') document.title = '爆音アラーム';
}

function nextOccurrence(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ---------- 再生 ----------

async function playLoop(url) {
  if (player.dataset.src !== url) {
    player.src = url;
    player.dataset.src = url;
  }
  player.loop = true;
  await player.play();
}

function prepareAudioSession() {
  // Safari 17+: 再生用セッションにしてサイレントスイッチの影響を受けないようにする
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* 未対応 */ }
}

function setupMediaSession(title) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: '爆音アラーム' });
  // ロック画面の一時停止ボタンでは止めさせない
  const keep = () => { if (state === 'armed' || state === 'ringing') player.play().catch(() => {}); };
  for (const action of ['pause', 'stop']) {
    try { navigator.mediaSession.setActionHandler(action, keep); } catch { /* 未対応 */ }
  }
  try { navigator.mediaSession.setActionHandler('play', keep); } catch { /* 未対応 */ }
}

async function requestWakeLock() {
  const el = $('wake');
  if (!('wakeLock' in navigator)) {
    el.textContent = '画面の自動ロックを止められない環境です。設定で自動ロックを「なし」にすると確実です';
    el.classList.add('warn');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    el.textContent = '画面はつけたままにしています';
    el.classList.remove('warn');
    wakeLock.addEventListener('release', () => {
      if (state === 'armed') {
        el.textContent = '画面の自動ロックが戻りました。アプリに戻ると再度止めます';
        el.classList.add('warn');
      }
    });
  } catch {
    el.textContent = '画面の自動ロックを止められませんでした。低電力モードを確認してください';
    el.classList.add('warn');
  }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ---------- 操作 ----------

async function arm(at) {
  clearTimeout(testTimer);
  prepareAudioSession();
  target = at;
  save({ target, time: $('time').value, sound: selectedSound() });
  try {
    await playLoop(silentUrl);
  } catch {
    alert('音の準備に失敗しました。もう一度ボタンを押してください');
    return;
  }
  setupMediaSession(`${fmtTime(target)} に鳴ります`);
  $('target').textContent = fmtTime(target);
  setState('armed');
  requestWakeLock();
  tick();
}

async function ring() {
  setState('ringing');
  setupMediaSession('起きて！！');
  try {
    await playLoop(soundUrl(load().sound || selectedSound()));
  } catch {
    // バックグラウンドで再生できなかった場合、画面に戻った時点で鳴らし直す
  }
}

function disarm() {
  target = 0;
  save({ target: 0 });
  player.pause();
  player.removeAttribute('src');
  delete player.dataset.src;
  player.load();
  releaseWakeLock();
  setState('idle');
}

async function testSound() {
  clearTimeout(testTimer);
  prepareAudioSession();
  try {
    await playLoop(soundUrl(selectedSound()));
  } catch {
    alert('再生できませんでした');
    return;
  }
  testTimer = setTimeout(() => { if (state === 'idle') player.pause(); }, 3000);
}

// ---------- 長押しで停止 ----------

let holdStart = 0;
let holdRaf = 0;

function holdFrame() {
  const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
  $('stopFill').style.width = `${p * 100}%`;
  if (p >= 1) { holdEnd(); disarm(); return; }
  holdRaf = requestAnimationFrame(holdFrame);
}
function holdBegin(e) {
  if (e) e.preventDefault();
  if (holdStart) return;
  holdStart = performance.now();
  holdRaf = requestAnimationFrame(holdFrame);
}
function holdEnd() {
  holdStart = 0;
  cancelAnimationFrame(holdRaf);
  $('stopFill').style.width = '0';
}

// ---------- 時計 ----------

function tick() {
  const now = Date.now();
  const d = new Date(now);
  $('now').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  if (state === 'armed') {
    if (now >= target) { ring(); return; }
    const left = Math.ceil((target - now) / 60000);
    const h = Math.floor(left / 60), m = left % 60;
    $('remain').textContent = `あと ${h ? `${h}時間` : ''}${m}分`;
  } else if (state === 'ringing') {
    document.title = document.title === '起きて！！' ? '⏰⏰⏰' : '起きて！！';
    if (player.paused) player.play().catch(() => {});
  }
}

// ---------- 起動 ----------

function init() {
  const saved = load();
  if (saved.time) $('time').value = saved.time;
  if (saved.sound) {
    const r = document.querySelector(`input[name="sound"][value="${saved.sound}"]`);
    if (r) r.checked = true;
  }

  $('arm').addEventListener('click', () => {
    const v = $('time').value;
    if (!v) { $('time').focus(); return; }
    arm(nextOccurrence(v));
  });
  $('test').addEventListener('click', testSound);
  $('cancel').addEventListener('click', disarm);
  $('resumeBtn').addEventListener('click', () => arm(target));

  const stop = $('stop');
  stop.addEventListener('pointerdown', holdBegin);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) stop.addEventListener(ev, holdEnd);
  stop.addEventListener('contextmenu', (e) => e.preventDefault());
  stop.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') holdBegin(e); });
  stop.addEventListener('keyup', holdEnd);

  // 鳴動中に何かで止められたら鳴らし直す
  player.addEventListener('pause', () => {
    if (state === 'ringing') setTimeout(() => player.play().catch(() => {}), 300);
  });
  player.addEventListener('timeupdate', tick);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state === 'armed') { requestWakeLock(); player.play().catch(() => {}); }
    tick();
  });

  // 再読み込み前にセットしていたアラームがあれば再開を促す(1時間以上過ぎたものは捨てる)
  if (saved.target && saved.target > Date.now() - 60 * 60 * 1000) {
    target = saved.target;
    setState('resume');
  } else {
    setState('idle');
  }

  setInterval(tick, 250);
  tick();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
