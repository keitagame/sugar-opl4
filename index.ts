// OPL3 (YMF262) / OPL4 (YMF278B) チップエミュレーション — sugaropl4.js からの AssemblyScript 移植
// 公開 API は末尾の export 関数のみ。FX / VGM パースは JS 側。

const OPL4_CLOCK: f64 = 33868800;
const MEM_SIZE: i32 = 0x400000;
const MEM_MASK: i32 = MEM_SIZE - 1;
const RAM_BASE: i32 = 0x200000;
const FM_GAIN: f64 = 1.6 / 32768;
const PCM_GAIN: f64 = 0.5 / 32768;
const FM_NORM_AUDIO: f64 = 4096 * FM_GAIN;
const LN2_32: f64 = Math.LN2 / 32;
const BLOCK_MAX: i32 = 8192;

const KSL_ROM: StaticArray<i32> = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT: StaticArray<i32> = [8, 1, 2, 0];
const MULT2: StaticArray<i32> = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
const SLOT_MAP: StaticArray<i32> = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17, -1, -1];
const PAN_L: StaticArray<i32> = [0, 8, 16, 24, 32, 40, 48, 256, 256, 0, 0, 0, 0, 0, 0, 0];
const PAN_R: StaticArray<i32> = [0, 0, 0, 0, 0, 0, 0, 0, 256, 256, 48, 40, 32, 24, 16, 8];
const LFO_HZ: StaticArray<f64> = [0.168, 2.019, 3.196, 4.206, 5.215, 5.888, 6.224, 7.066];
const VIB_CENTS: StaticArray<f64> = [0, 3.378, 5.065, 6.750, 10.114, 20.170, 40.106, 79.307];
const AM_UNITS: StaticArray<f64> = [0, 1.781 / 0.09375, 2.906 / 0.09375, 3.656 / 0.09375, 4.406 / 0.09375, 5.406 / 0.09375, 6.406 / 0.09375, 7.406 / 0.09375];

const RATE_DEC = new StaticArray<f64>(64);
const RATE_ATK = new StaticArray<f64>(64);
for (let r = 1; r < 64; r++) {
  const m = Math.pow(2, <f64>((r >> 2) - 1)) * (1 + <f64>(r & 3) / 4);
  RATE_DEC[r] = 2.6217e-4 * m;
  RATE_ATK[r] = Math.min(0.9, 4.438e-5 * m);
}
const AMP_TAB = new StaticArray<f64>(2048);
for (let i = 0; i < 2048; i++) AMP_TAB[i] = i >= 1023 ? 0 : Math.pow(2, -<f64>i / 64);
const MIX_GAIN = new StaticArray<f64>(8);
for (let i = 0; i < 8; i++) MIX_GAIN[i] = i >= 7 ? 0 : Math.pow(10, -3.0 * <f64>i / 20);

function ampOf(att0: f64): f64 {
  let att = att0;
  if (att < 0) att = 0;
  if (att >= 1022) return 0;
  const i = <i32>att, f = att - <f64>i;
  return unchecked(AMP_TAB[i]) + (unchecked(AMP_TAB[i + 1]) - unchecked(AMP_TAB[i])) * f;
}
function cubic(a: f64, b: f64, c: f64, d: f64, t: f64): f64 {
  return 0.5 * ((2 * b) + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
}

// ---- 共有メモリ (ROM/RAM 4MB) / 入出力バッファ ----
const MEM_PTR: usize = memory.data(MEM_SIZE);
const PARAMS = new StaticArray<f64>(32);
const OUT_L = new StaticArray<f64>(BLOCK_MAX);
const OUT_R = new StaticArray<f64>(BLOCK_MAX);

@inline function ldF64(base: usize, i: i32): f64 { return load<f64>(base + (<usize>i << 3)); }
@inline function ldF32(base: usize, i: i32): f64 { return <f64>load<f32>(base + (<usize>i << 2)); }
@inline function ldI32(base: usize, i: i32): i32 { return load<i32>(base + (<usize>i << 2)); }
@inline function stF64(base: usize, i: i32, v: f64): void { store<f64>(base + (<usize>i << 3), v); }
@inline function mb(a: i32): i32 { return <i32>load<u8>(MEM_PTR + <usize>(a & MEM_MASK)); }

// ---- FM 音質 ----
class FmQ {
  oversample: i32 = 4; egSmooth: f64 = 0.14; waveSoft: f64 = 0.008; fbScale: f64 = 0.92;
  lfoSmooth: bool = true; softKeyOn: bool = true;
  deharsh: f64 = 0.55; deharshThr: f64 = 0.045; deharshHz: f64 = 2800;
  shelfDb: f64 = -2; shelfHz: f64 = 6500; rhythmLpHz: f64 = 11000;
  // 透明感重視の追加パラメータ (0 = 無効 → 従来どおりの音)
  presenceDb: f64 = 0; presenceHz: f64 = 4500; presenceQ: f64 = 0.9; airDb: f64 = 0; airHz: f64 = 10000;
  deharshHiHz: f64 = 0; deharshAtkMs: f64 = 0; deharshRelMs: f64 = 0;
}
function readQ(): FmQ {
  const q = new FmQ();
  q.oversample = <i32>PARAMS[0]; q.egSmooth = PARAMS[1]; q.waveSoft = PARAMS[2]; q.fbScale = PARAMS[3];
  q.lfoSmooth = PARAMS[4] != 0; q.softKeyOn = PARAMS[5] != 0;
  q.deharsh = PARAMS[6]; q.deharshThr = PARAMS[7]; q.deharshHz = PARAMS[8];
  q.shelfDb = PARAMS[9]; q.shelfHz = PARAMS[10]; q.rhythmLpHz = PARAMS[11];
  q.presenceDb = PARAMS[12]; q.presenceHz = PARAMS[13]; q.presenceQ = PARAMS[14];
  q.airDb = PARAMS[15]; q.airHz = PARAMS[16];
  q.deharshHiHz = PARAMS[17]; q.deharshAtkMs = PARAMS[18]; q.deharshRelMs = PARAMS[19];
  return q;
}

// ---- 波形テーブル ----
const WT_N: i32 = 4096;
const WT_STRIDE: i32 = WT_N + 1;
const waveCache = new Map<i32, Float32Array>();

function waveShape(wf: i32, x: f64): f64 {
  const TAU = 2 * Math.PI;
  switch (wf) {
    case 0: return Math.sin(TAU * x);
    case 1: return x < 0.5 ? Math.sin(TAU * x) : 0;
    case 2: return Math.abs(Math.sin(TAU * x));
    case 3: { const q = <i32>(x * 4); return (q & 1) ? 0 : Math.sin(TAU * (x - <f64>q * 0.25)); }
    case 4: return x < 0.5 ? Math.sin(2 * TAU * x) : 0;
    case 5: return x < 0.5 ? Math.abs(Math.sin(2 * TAU * x)) : 0;
    case 6: return x < 0.5 ? 1 : -1;
    default: {
      if (x < 0.5) return Math.pow(2, -(x * 1024) / 32);
      const q = Math.max(0, 511 - (x - 0.5) * 1024);
      return -Math.pow(2, -q / 32);
    }
  }
}
function smoothCircular(f: Float64Array, w: i32, passes: i32): void {
  const n = f.length, tmp = new Float64Array(n);
  const h = max(1, w >> 1), len = 2 * h + 1;
  for (let p = 0; p < passes; p++) {
    let sum: f64 = 0;
    for (let j = -h; j <= h; j++) sum += f[(j + n) % n];
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / <f64>len;
      sum += f[(i + h + 1) % n] - f[(i - h + n) % n];
    }
    f.set(tmp);
  }
}
function buildWaveTables(soft: f64): Float32Array {
  const key = <i32>Math.round(soft * 10000);
  if (waveCache.has(key)) return waveCache.get(key);
  const FINE = 16384, ratio = FINE / WT_N;
  const t = new Float32Array(8 * WT_STRIDE);
  const f = new Float64Array(FINE);
  for (let wf = 0; wf < 8; wf++) {
    for (let i = 0; i < FINE; i++) f[i] = waveShape(wf, <f64>i / <f64>FINE);
    if (soft > 0 && wf != 0) smoothCircular(f, <i32>Math.round(soft * <f64>FINE), 2);
    const o = wf * WT_STRIDE;
    for (let i = 0; i < WT_N; i++) t[o + i] = <f32>f[i * ratio];
    t[o + WT_N] = t[o];
  }
  waveCache.set(key, t);
  return t;
}

function besselI0(x: f64): f64 {
  let sum: f64 = 1, term: f64 = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 40; k++) {
    term *= q / <f64>(k * k); sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

// ---- ハーフバンド・デシメータ ----
class HalfbandDec {
  L: i32 = 0; idx!: Int32Array; co!: Float64Array; bL!: Float64Array; bR!: Float64Array;
  p: i32 = 0; ph: i32 = 0; oL: f64 = 0; oR: f64 = 0; n: i32 = 0;
  constructor(m: i32, beta: f64 = 8) {
    const L = 4 * m + 1, c = 2 * m;
    const h = new Float64Array(L), i0b = besselI0(beta);
    let sum: f64 = 0;
    for (let i = 0; i < L; i++) {
      const n = i - c, x = <f64>n / <f64>c;
      const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - x * x))) / i0b;
      let v: f64 = 0;
      if (n == 0) v = 0.5;
      else if (n & 1) v = Math.round(Math.sin(Math.PI * <f64>n / 2)) / (Math.PI * <f64>n) * w;
      h[i] = v; sum += v;
    }
    let cnt = 0;
    for (let i = 0; i < L; i++) if (h[i] != 0) cnt++;
    this.idx = new Int32Array(cnt); this.co = new Float64Array(cnt);
    let k = 0;
    for (let i = 0; i < L; i++) if (h[i] != 0) { this.idx[k] = i; this.co[k] = h[i] / sum; k++; }
    this.L = L; this.n = cnt;
    this.bL = new Float64Array(2 * L); this.bR = new Float64Array(2 * L);
  }
  push(l: f64, r: f64): bool {
    const p = this.p, L = this.L;
    const pl = this.bL.dataStart, pr = this.bR.dataStart;
    stF64(pl, p, l); stF64(pl, p + L, l);
    stF64(pr, p, r); stF64(pr, p + L, r);
    this.p = p + 1 >= L ? 0 : p + 1;
    this.ph ^= 1;
    if (this.ph) return false;
    const base = this.p, n = this.n;
    let sl: f64 = 0, sr: f64 = 0;
    const co = this.co.dataStart, ix = this.idx.dataStart, ql = this.bL.dataStart, qr = this.bR.dataStart;
    for (let j = 0; j < n; j++) {
      const c = ldF64(co, j), k = base + ldI32(ix, j);
      sl += c * ldF64(ql, k); sr += c * ldF64(qr, k);
    }
    this.oL = sl; this.oR = sr;
    return true;
  }
}

// ---- トーン整形: EQ (シェルフ/ピーキング) + 帯域限定ダイナミック抑制 (ディエッサ的) ----
class Biquad {                            // モノラル 1 段 (直接形 I)
  b0: f64 = 1; b1: f64 = 0; b2: f64 = 0; a1: f64 = 0; a2: f64 = 0;
  x1: f64 = 0; x2: f64 = 0; y1: f64 = 0; y2: f64 = 0;
  reset(): void { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  set(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64): void {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  highShelf(fs: f64, dB: f64, hz: f64): void {      // RBJ ハイシェルフ (S = 1)
    const A = Math.pow(10, dB / 40), w0 = 2 * Math.PI * hz / fs;
    const cs = Math.cos(w0), al = Math.sin(w0) / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
    this.set(A * ((A + 1) + (A - 1) * cs + sA), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - sA),
             (A + 1) - (A - 1) * cs + sA, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - sA);
  }
  peak(fs: f64, dB: f64, hz: f64, Q: f64): void {   // RBJ ピーキング
    const A = Math.pow(10, dB / 40), w0 = 2 * Math.PI * hz / fs, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Q);
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }
  lowpass(fs: f64, hz: f64): void {                 // 2次バタワース
    const w0 = 2 * Math.PI * hz / fs, cs = Math.cos(w0), al = Math.sin(w0) / Math.SQRT2;
    this.set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  }
  highpass(fs: f64, hz: f64): void {                // 2次バタワース
    const w0 = 2 * Math.PI * hz / fs, cs = Math.cos(w0), al = Math.sin(w0) / Math.SQRT2;
    this.set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  }
  @inline run(x: f64): f64 {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class Lr4 {                               // Linkwitz-Riley 4次 = 2次バタワース2段
  a: Biquad = new Biquad(); b: Biquad = new Biquad();
  lp(fs: f64, hz: f64): void { this.a.lowpass(fs, hz); this.b.lowpass(fs, hz); }
  hp(fs: f64, hz: f64): void { this.a.highpass(fs, hz); this.b.highpass(fs, hz); }
  reset(): void { this.a.reset(); this.b.reset(); }
  @inline run(x: f64): f64 { return this.b.run(this.a.run(x)); }
}

/** 1 チャンネル分の 3 バンド LR4 分割。low + mid + high は全域通過 (位相整合済み) */
class Split3 {
  lo1: Lr4 = new Lr4(); hp1: Lr4 = new Lr4();          // f1 での LP / HP
  midLp: Lr4 = new Lr4(); hiHp: Lr4 = new Lr4();       // f2 での LP / HP (hp1 の出力に適用)
  cmpLp: Lr4 = new Lr4(); cmpHp: Lr4 = new Lr4();      // 低域を f2 の全域通過に通して位相を揃える
  low: f64 = 0; mid: f64 = 0; high: f64 = 0;
  reset(): void {
    this.lo1.reset(); this.hp1.reset(); this.midLp.reset(); this.hiHp.reset(); this.cmpLp.reset(); this.cmpHp.reset();
  }
  setup(fs: f64, f1: f64, f2: f64): void {
    this.lo1.lp(fs, f1); this.hp1.hp(fs, f1);
    this.midLp.lp(fs, f2); this.hiHp.hp(fs, f2);
    this.cmpLp.lp(fs, f2); this.cmpHp.hp(fs, f2);
  }
  run(x: f64): void {
    const lo = this.lo1.run(x), hp = this.hp1.run(x);
    this.mid = this.midLp.run(hp); this.high = this.hiHp.run(hp);
    this.low = this.cmpLp.run(lo) + this.cmpHp.run(lo);
  }
}

class FmTone {
  rate: f64; oL: f64 = 0; oR: f64 = 0;
  shelfL: Biquad = new Biquad(); shelfR: Biquad = new Biquad();
  presL: Biquad = new Biquad(); presR: Biquad = new Biquad();
  airL: Biquad = new Biquad(); airR: Biquad = new Biquad();
  sL: Split3 = new Split3(); sR: Split3 = new Split3();
  shelfOn: bool = false; presOn: bool = false; airOn: bool = false;
  lpAL: f64 = 0; lpBL: f64 = 0; lpAR: f64 = 0; lpBR: f64 = 0; env: f64 = 0;
  dhOn: bool = false; dhBand: bool = false; dhThr: f64 = 0; dhExp: f64 = 0; aLp: f64 = 0; aAtk: f64 = 0; aRel: f64 = 0;
  constructor(rate: f64) { this.rate = rate; }
  setup(q: FmQ): void {
    const fs = this.rate;
    this.shelfOn = q.shelfDb != 0; this.presOn = q.presenceDb != 0; this.airOn = q.airDb != 0;
    if (this.shelfOn) { this.shelfL.highShelf(fs, q.shelfDb, q.shelfHz); this.shelfR.highShelf(fs, q.shelfDb, q.shelfHz); }
    if (this.presOn) {
      const Q = q.presenceQ > 0 ? q.presenceQ : 0.9;
      this.presL.peak(fs, q.presenceDb, q.presenceHz, Q); this.presR.peak(fs, q.presenceDb, q.presenceHz, Q);
    }
    if (this.airOn) { this.airL.highShelf(fs, q.airDb, q.airHz); this.airR.highShelf(fs, q.airDb, q.airHz); }
    this.dhOn = q.deharsh > 0;
    this.dhThr = q.deharshThr;
    this.dhExp = 1 - 1 / (1 + 5 * q.deharsh);
    this.aLp = 1 - Math.exp(-2 * Math.PI * q.deharshHz / fs);
    this.dhBand = q.deharshHiHz > q.deharshHz;
    if (this.dhBand) {
      const f2 = Math.min(q.deharshHiHz, fs * 0.42);
      this.sL.setup(fs, q.deharshHz, f2); this.sR.setup(fs, q.deharshHz, f2);
    }
    this.aAtk = 1 - Math.exp(-1 / ((q.deharshAtkMs > 0 ? q.deharshAtkMs : 1) * 0.001 * fs));
    this.aRel = 1 - Math.exp(-1 / ((q.deharshRelMs > 0 ? q.deharshRelMs : 50) * 0.001 * fs));
  }
  process(inL: f64, inR: f64): void {
    let l = inL, r = inR;
    if (this.shelfOn) { l = this.shelfL.run(l); r = this.shelfR.run(r); }
    if (this.presOn) { l = this.presL.run(l); r = this.presR.run(r); }
    if (this.airOn) { l = this.airL.run(l); r = this.airR.run(r); }
    if (this.dhOn) {
      if (this.dhBand) {
        const sl = this.sL, sr = this.sR;
        sl.run(l); sr.run(r);
        const e = Math.max(Math.abs(sl.mid), Math.abs(sr.mid));
        this.env += (e - this.env) * (e > this.env ? this.aAtk : this.aRel);
        const g = this.env > this.dhThr ? Math.pow(this.dhThr / this.env, this.dhExp) : 1;
        l = sl.low + g * sl.mid + sl.high; r = sr.low + g * sr.mid + sr.high;
      } else {
        const a = this.aLp;
        this.lpAL += (l - this.lpAL) * a; this.lpBL += (this.lpAL - this.lpBL) * a;
        this.lpAR += (r - this.lpAR) * a; this.lpBR += (this.lpAR - this.lpBR) * a;
        const hL = l - this.lpBL, hR = r - this.lpBR;
        const e = Math.max(Math.abs(hL), Math.abs(hR));
        this.env += (e - this.env) * (e > this.env ? this.aAtk : this.aRel);
        const g = this.env > this.dhThr ? Math.pow(this.dhThr / this.env, this.dhExp) : 1;
        l = this.lpBL + hL * g; r = this.lpBR + hR * g;
      }
    }
    this.oL = l; this.oR = r;
  }
}

// =====================================================================
//  OPL3 FM コア
// =====================================================================
class OplSlot {
  ch: OplChan;
  mult: i32 = 0; ksr: i32 = 0; egt: i32 = 0; vib: i32 = 0; am: i32 = 0;
  tl: i32 = 0; kslReg: i32 = 0; kslAtt: i32 = 0;
  ar: i32 = 0; dr: i32 = 0; sl: i32 = 0; rr: i32 = 0; wf: i32 = 0;
  ph: f64 = 0; inc: f64 = 0; pout: i32 = 0; fixed: bool = false; fixPh: f64 = 0;
  att: f64 = 511; state: i32 = 3; keys: i32 = 0;
  egS: f64 = 511; amp: f64 = 0; out: f64 = 0;
  fh: Float64Array = new Float64Array(1); fi: i32 = 0;
  constructor(ch: OplChan) { this.ch = ch; }
}
class OplChan {
  num: i32;
  fnum: i32 = 0; block: i32 = 0; kcode: i32 = 0;
  cha: i32 = 0; chb: i32 = 0; fb: i32 = 0; cnt: i32 = 0; kon: i32 = 0;
  s0!: OplSlot; s1!: OplSlot;
  constructor(num: i32) {
    this.num = num;
    this.s0 = new OplSlot(this);
    this.s1 = new OplSlot(this);
  }
}

class OPL3Core {
  rate: f64;
  slots: Array<OplSlot> = new Array<OplSlot>();
  chans: Array<OplChan> = new Array<OplChan>();
  newm: bool = false; fourop: i32 = 0; nts: bool = false;
  deepAm: bool = false; deepVib: bool = false; rhythm: bool = false;
  timer: i32 = 0; tremPos: i32 = 0; vibPos: i32 = 0; tremolo: f64 = 0; vibLfo: f64 = 0;
  noise: i32 = 1;
  outL: f64 = 0; outR: f64 = 0; rl7: f64 = 0; rl8: f64 = 0; dL: f64 = 0; dR: f64 = 0;
  ovs: i32 = 0; decs: Array<HalfbandDec> = new Array<HalfbandDec>();
  tone!: FmTone;
  q!: FmQ; wt!: Float32Array; wtp: usize = 0; egK: f64 = 1; lfoSmooth: bool = true;
  fbK: Float64Array = new Float64Array(8); rLpA: f64 = 1; kind: StaticArray<i32> = new StaticArray<i32>(18);

  constructor(q: FmQ, rate: f64) {
    this.rate = rate;
    for (let c = 0; c < 18; c++) this.chans.push(new OplChan(c));
    for (let i = 0; i < 36; i++) this.slots.push(this.chans[0].s0);   // 仮埋め
    for (let c = 0; c < 18; c++) {
      const bank = c >= 9 ? 1 : 0, w = c % 9;
      const base = bank * 18 + (w / 3) * 6 + (w % 3);
      this.slots[base] = this.chans[c].s0;
      this.slots[base + 3] = this.chans[c].s1;
    }
    this.tone = new FmTone(rate);
    this.q = q;
    this.wt = buildWaveTables(q.waveSoft);
    this.setQuality(q);
  }

  setQuality(c: FmQ): void {
    this.q = c;
    if (c.oversample != this.ovs) {
      this.ovs = c.oversample;
      this.decs = new Array<HalfbandDec>();
      for (let o = this.ovs; o > 1; o >>= 1) this.decs.push(new HalfbandDec(o == 2 ? 15 : 6));
      for (let i = 0; i < 36; i++) { const s = this.slots[i]; s.fh = new Float64Array(2 * this.ovs + 1); s.fi = 0; }
    }
    this.wt = buildWaveTables(c.waveSoft); this.wtp = this.wt.dataStart;
    this.egK = Math.min(1, Math.max(0.01, c.egSmooth));
    this.lfoSmooth = c.lfoSmooth;
    for (let fb = 1; fb < 8; fb++) this.fbK[fb] = Math.pow(2, <f64>(fb - 7)) * c.fbScale;
    this.rLpA = c.rhythmLpHz > 0 ? 1 - Math.exp(-2 * Math.PI * c.rhythmLpHz / (this.rate * <f64>this.ovs)) : 1;
    this.tone.setup(c);
  }

  isLower4(c: i32): bool {
    if (!this.newm) return false;
    if (c < 3) return ((this.fourop >> c) & 1) == 1;
    if (c >= 9 && c < 12) return ((this.fourop >> (c - 6)) & 1) == 1;
    return false;
  }
  isUpper4(c: i32): bool {
    if (!this.newm) return false;
    if (c >= 3 && c < 6) return ((this.fourop >> (c - 3)) & 1) == 1;
    if (c >= 12 && c < 15) return ((this.fourop >> (c - 9)) & 1) == 1;
    return false;
  }

  keyOn(s: OplSlot, flag: i32): void {
    const was = s.keys;
    s.keys |= flag;
    if (!was) {
      s.state = 0;
      if (!this.q.softKeyOn || s.egS > 440) s.ph = 0;
    }
  }
  keyOff(s: OplSlot, flag: i32): void {
    const was = s.keys;
    s.keys &= ~flag;
    if (was && !s.keys) s.state = 3;
  }

  updateFreq(ch: OplChan): void {
    ch.kcode = (ch.block << 1) | (this.nts ? (ch.fnum >> 8) & 1 : (ch.fnum >> 9) & 1);
    this.updateKsl(ch.s0, ch); this.updateKsl(ch.s1, ch);
  }
  updateKsl(s: OplSlot, ch: OplChan): void {
    if (!s.kslReg) { s.kslAtt = 0; return; }
    let v = (KSL_ROM[ch.fnum >> 6] << 2) - ((8 - ch.block) << 5);
    if (v < 0) v = 0;
    s.kslAtt = v >> KSL_SHIFT[s.kslReg];
  }
  applyKey(cc: OplChan, on: bool): void {
    if (on) { this.keyOn(cc.s0, 1); this.keyOn(cc.s1, 1); }
    else { this.keyOff(cc.s0, 1); this.keyOff(cc.s1, 1); }
  }
  setChanKey(c: i32, on: bool): void {
    const ch = this.chans[c];
    ch.kon = on ? 1 : 0;
    this.applyKey(ch, on);
    if (this.isLower4(c)) this.applyKey(this.chans[c + 3], on);
  }
  copyFreq(src: OplChan, dst: OplChan): void {
    dst.fnum = src.fnum; dst.block = src.block;
    this.updateFreq(dst);
  }

  write(bank: i32, reg0: i32, data0: i32): void {
    const reg = reg0 & 0xff, data = data0 & 0xff;
    if (bank == 1) {
      if (reg == 0x04) { this.fourop = data & 0x3f; return; }
      if (reg == 0x05) { this.newm = (data & 1) != 0; return; }
    } else {
      if (reg == 0x08) {
        this.nts = (data & 0x40) != 0;
        for (let i = 0; i < 18; i++) this.updateFreq(this.chans[i]);
        return;
      }
      if (reg == 0xbd) { this.writeBD(data); return; }
    }
    if (bank == 1 && !this.newm) return;

    if (reg >= 0xa0 && reg <= 0xc8) {
      const g = reg & 0xf0, n = reg & 0x0f;
      if (n > 8) return;
      const c = bank * 9 + n;
      const ch = this.chans[c];
      if (g == 0xa0) {
        if (this.isUpper4(c)) return;
        ch.fnum = (ch.fnum & 0x300) | data;
        this.updateFreq(ch);
        if (this.isLower4(c)) this.copyFreq(ch, this.chans[c + 3]);
      } else if (g == 0xb0) {
        if (this.isUpper4(c)) return;
        ch.fnum = (ch.fnum & 0xff) | ((data & 3) << 8);
        ch.block = (data >> 2) & 7;
        this.updateFreq(ch);
        if (this.isLower4(c)) this.copyFreq(ch, this.chans[c + 3]);
        this.setChanKey(c, (data & 0x20) != 0);
      } else {
        ch.cha = (data >> 4) & 1;
        ch.chb = (data >> 5) & 1;
        ch.fb = (data >> 1) & 7;
        ch.cnt = data & 1;
      }
      return;
    }

    if ((reg >= 0x20 && reg <= 0x95) || (reg >= 0xe0 && reg <= 0xf5)) {
      const g = reg & 0xe0, o = reg & 0x1f;
      const si = SLOT_MAP[o];
      if (si < 0 || o > 0x15) return;
      const s = this.slots[bank * 18 + si];
      if (g == 0x20) {
        s.am = (data >> 7) & 1; s.vib = (data >> 6) & 1; s.egt = (data >> 5) & 1;
        s.ksr = (data >> 4) & 1; s.mult = data & 15;
      } else if (g == 0x40) {
        s.kslReg = data >> 6; s.tl = data & 63;
        this.updateKsl(s, s.ch);
      } else if (g == 0x60) { s.ar = data >> 4; s.dr = data & 15; }
      else if (g == 0x80) { s.sl = (data >> 4) == 15 ? 31 : (data >> 4); s.rr = data & 15; }
      else if (g == 0xe0) { s.wf = data & (this.newm ? 7 : 3); }
    }
  }

  setKey2(idx: i32, on: bool): void {
    if (on) this.keyOn(this.slots[idx], 2); else this.keyOff(this.slots[idx], 2);
  }
  writeBD(data: i32): void {
    this.deepAm = (data & 0x80) != 0;
    this.deepVib = (data & 0x40) != 0;
    const r = (data & 0x20) != 0;
    if (r != this.rhythm) {
      this.rhythm = r;
      if (!r) for (let i = 12; i < 18; i++) this.keyOff(this.slots[i], 2);
    }
    if (r) {
      this.setKey2(12, (data & 0x10) != 0); this.setKey2(15, (data & 0x10) != 0);
      this.setKey2(16, (data & 0x08) != 0);
      this.setKey2(14, (data & 0x04) != 0);
      this.setKey2(17, (data & 0x02) != 0);
      this.setKey2(13, (data & 0x01) != 0);
    }
  }

  rateOf(s: OplSlot, reg: i32): i32 {
    if (!reg) return 0;
    const r = (reg << 2) + (s.ch.kcode >> (s.ksr ? 0 : 2));
    return r > 63 ? 63 : r;
  }

  advance(s: OplSlot): void {
    let att = s.att;
    const st = s.state;
    if (st == 0) {
      const r = this.rateOf(s, s.ar);
      if (r > 0) {
        if ((r >> 2) >= 15) att = 0;
        else { att -= att * unchecked(RATE_ATK[r]); if (att < 0.4) att = 0; }
      }
      if (att <= 0) { att = 0; s.state = 1; }
    } else if (st == 1) {
      att += unchecked(RATE_DEC[this.rateOf(s, s.dr)]);
      const sl = <f64>(s.sl << 4);
      if (att >= sl) { att = sl; s.state = 2; }
    } else if (st == 2) {
      if (!s.egt) att += unchecked(RATE_DEC[this.rateOf(s, s.rr)]);
    } else {
      att += unchecked(RATE_DEC[this.rateOf(s, s.rr)]);
    }
    if (att > 511) att = 511;
    s.att = att;

    const ch = s.ch;
    let inc: f64;
    if (this.lfoSmooth) {
      let fn = <f64>ch.fnum;
      if (s.vib) fn += (<f64>ch.fnum / 128) * this.vibLfo * (this.deepVib ? 1 : 0.5);
      inc = fn * <f64>(1 << ch.block) * <f64>MULT2[s.mult] / 2097152;
    } else {
      let fn = ch.fnum;
      if (s.vib) {
        let range = (fn >> 7) & 7;
        const vp = this.vibPos;
        if (!(vp & 3)) range = 0;
        else if (vp & 1) range >>= 1;
        if (!this.deepVib) range >>= 1;
        if (vp & 4) range = -range;
        fn += range;
      }
      inc = <f64>((((fn << ch.block) >> 1) * MULT2[s.mult]) >> 1) / 524288;
    }
    s.inc = inc / <f64>this.ovs;
    s.pout = <i32>(s.ph * 1024);

    let eg = att + <f64>((s.tl << 2) + s.kslAtt) + (s.am ? this.tremolo : 0);
    if (eg > 511) eg = 511;
    let es = s.egS + (eg - s.egS) * this.egK;
    if (es > 511) es = 511;
    s.egS = es;
    s.amp = es >= 496 ? 0 : Math.exp(-es * LN2_32);
  }

  @inline wave(s: OplSlot, mod: f64): f64 {
    const a = s.amp;
    if (a == 0) return 0;
    let ph = (s.fixed ? s.fixPh : s.ph) + mod;
    ph -= Math.floor(ph);
    const x = ph * <f64>WT_N, i = <i32>x, o = s.wf * WT_STRIDE + i;
    const t = this.wtp, v0 = ldF32(t, o);
    return a * (v0 + (ldF32(t, o + 1) - v0) * (x - <f64>i));
  }

  fbMod(s: OplSlot, fb: i32): f64 {
    const fh = s.fh, R = fh.length, o = this.ovs;
    let a = s.fi - o; if (a < 0) a += R;
    let b = s.fi - 2 * o; if (b < 0) b += R;
    const p = fh.dataStart;
    return (ldF64(p, a) + ldF64(p, b)) * ldF64(this.fbK.dataStart, fb);
  }
  fbPush(s: OplSlot): void {
    stF64(s.fh.dataStart, s.fi, s.out);
    s.fi = s.fi + 1 >= s.fh.length ? 0 : s.fi + 1;
  }

  calc2op(ch: OplChan): f64 {
    const m = ch.s0, c = ch.s1;
    m.out = this.wave(m, ch.fb ? this.fbMod(m, ch.fb) : 0);
    if (ch.fb) this.fbPush(m);
    if (ch.cnt) { c.out = this.wave(c, 0); return m.out + c.out; }
    c.out = this.wave(c, m.out * 2);
    return c.out;
  }

  calc4op(L: OplChan, U: OplChan): f64 {
    const m1 = L.s0, c1 = L.s1, m2 = U.s0, c2 = U.s1;
    m1.out = this.wave(m1, L.fb ? this.fbMod(m1, L.fb) : 0);
    if (L.fb) this.fbPush(m1);
    const mode = (L.cnt << 1) | U.cnt;
    if (mode == 0) {
      c1.out = this.wave(c1, m1.out * 2);
      m2.out = this.wave(m2, c1.out * 2);
      c2.out = this.wave(c2, m2.out * 2);
      return c2.out;
    } else if (mode == 1) {
      c1.out = this.wave(c1, m1.out * 2);
      m2.out = this.wave(m2, 0);
      c2.out = this.wave(c2, m2.out * 2);
      return c1.out + c2.out;
    } else if (mode == 2) {
      c1.out = this.wave(c1, 0);
      m2.out = this.wave(m2, c1.out * 2);
      c2.out = this.wave(c2, m2.out * 2);
      return m1.out + c2.out;
    }
    c1.out = this.wave(c1, 0);
    m2.out = this.wave(m2, c1.out * 2);
    c2.out = this.wave(c2, 0);
    return m1.out + m2.out + c2.out;
  }

  pushDec(l0: f64, r0: f64): bool {
    let l = l0, r = r0;
    const n = this.decs.length;
    for (let i = 0; i < n; i++) {
      const d = unchecked(this.decs[i]);
      if (!d.push(l, r)) return false;
      l = d.oL; r = d.oR;
    }
    this.dL = l; this.dR = r;
    return true;
  }

  generate(): void {
    this.timer = this.timer + 1;
    if ((this.timer & 63) == 0) { if (++this.tremPos >= 210) this.tremPos = 0; }
    if ((this.timer & 1023) == 0) this.vibPos = (this.vibPos + 1) & 7;
    if (this.lfoSmooth) {
      const pos = <f64>this.tremPos + <f64>(this.timer & 63) / 64;
      const tp = pos < 105 ? pos : 210 - pos;
      this.tremolo = tp / (this.deepAm ? 4 : 16);
      this.vibLfo = Math.sin(2 * Math.PI * (<f64>this.vibPos + <f64>(this.timer & 1023) / 1024) / 8);
    } else {
      const tp = this.tremPos < 105 ? this.tremPos : 210 - this.tremPos;
      this.tremolo = <f64>(tp >> (this.deepAm ? 2 : 4));
    }
    if (this.noise & 1) this.noise ^= 0x800302;
    this.noise = this.noise >>> 1;

    const S = this.slots, ovs = this.ovs;
    for (let i = 0; i < 36; i++) this.advance(unchecked(S[i]));

    const s13 = S[13], s16 = S[16], s17 = S[17];
    s13.fixed = this.rhythm; s16.fixed = this.rhythm; s17.fixed = this.rhythm;
    if (this.rhythm) {
      const hh2 = (s13.pout >> 2) & 1, hh3 = (s13.pout >> 3) & 1;
      const hh7 = (s13.pout >> 7) & 1, hh8 = (s13.pout >> 8) & 1;
      const tc3 = (s17.pout >> 3) & 1, tc5 = (s17.pout >> 5) & 1;
      const x = ((hh2 ^ hh7) | (hh3 ^ tc5) | (tc3 ^ tc5)) & 1;
      const nz = this.noise & 1;
      s13.fixPh = <f64>((x << 9) | ((x ^ nz) ? 0xd0 : 0x34)) / 1024;
      s16.fixPh = <f64>((hh8 << 9) | ((hh8 ^ nz) << 8)) / 1024;
      s17.fixPh = <f64>((x << 9) | 0x80) / 1024;
    }

    const nch = this.newm ? 18 : 9;
    const kind = this.kind;
    for (let c = 0; c < nch; c++) {
      let kd: i32 = 4;
      if (this.isUpper4(c)) kd = 0;
      else if (this.isLower4(c)) kd = 1;
      else if (this.rhythm && c == 7) kd = 2;
      else if (this.rhythm && c == 8) kd = 3;
      unchecked(kind[c] = kd);
    }
    for (let k = 0; k < ovs; k++) {
      for (let i = 0; i < 36; i++) {
        const s = unchecked(S[i]);
        let p = s.ph + s.inc;
        if (p >= 1) p -= <f64>(<i32>p);
        s.ph = p;
      }
      let L: f64 = 0, R: f64 = 0;
      for (let c = 0; c < nch; c++) {
        const ch = unchecked(this.chans[c]);
        let o: f64;
        const kd = unchecked(kind[c]);
        if (kd == 0) continue;
        if (kd == 1) {
          o = this.calc4op(ch, unchecked(this.chans[c + 3]));
        } else if (kd == 2) {
          const hh = ch.s0, sd = ch.s1;
          hh.out = this.wave(hh, 0); sd.out = this.wave(sd, 0);
          this.rl7 += ((hh.out + sd.out) * 2 - this.rl7) * this.rLpA;
          o = this.rl7;
        } else if (kd == 3) {
          const tom = ch.s0, tc = ch.s1;
          tom.out = this.wave(tom, 0); tc.out = this.wave(tc, 0);
          this.rl8 += ((tom.out + tc.out) * 2 - this.rl8) * this.rLpA;
          o = this.rl8;
        } else {
          o = this.calc2op(ch);
        }
        if (this.newm) {
          if (ch.cha) L += o;
          if (ch.chb) R += o;
        } else { L += o; R += o; }
      }
      this.pushDec(L, R);
    }

    this.tone.process(this.dL * FM_NORM_AUDIO, this.dR * FM_NORM_AUDIO);
    this.outL = this.tone.oL / FM_GAIN;
    this.outR = this.tone.oR / FM_GAIN;
  }
}

// =====================================================================
//  OPL4 PCM コア (メモリは共有 MEM_PTR)
// =====================================================================
class PcmVoice {
  wave: i32 = 0; fn: i32 = 0; oct: i32 = 0; prvb: i32 = 0;
  tl: i32 = 0; tlCur: i32 = 0; ld: i32 = 1;
  key: bool = false; damp: bool = false; pan: i32 = 0;
  lfo: i32 = 0; vib: i32 = 0; am: i32 = 0;
  ar: i32 = 0; d1r: i32 = 0; dl: i32 = 0; d2r: i32 = 0; rc: i32 = 0; rr: i32 = 0;
  fmt: i32 = 0; start: i32 = 0; loop: i32 = 0; end: i32 = 0x10000;
  pos: f64 = 0; att: f64 = 1023; state: i32 = 3; active: bool = false;
  lfoPh: f64 = 0; baseInc: f64 = 1; gL: f64 = 0; gR: f64 = 0;
}

class PcmCore {
  rate: f64;
  v: Array<PcmVoice> = new Array<PcmVoice>();
  hdrSel: i32 = 0; memAddr: i32 = 0; outL: f64 = 0; outR: f64 = 0;
  constructor(rate: f64) {
    this.rate = rate;
    for (let i = 0; i < 24; i++) this.v.push(new PcmVoice());
  }

  baseOf(v: PcmVoice): i32 {
    let base: i32;
    if (v.wave < 384 || this.hdrSel == 0) base = v.wave * 12;
    else base = this.hdrSel * 0x80000 + (v.wave - 384) * 12;
    return base & MEM_MASK;
  }
  geom(v: PcmVoice): void {
    const base = this.baseOf(v);
    v.fmt = mb(base) >> 6;
    v.start = ((mb(base) & 0x3f) << 16) | (mb(base + 1) << 8) | mb(base + 2);
    v.loop = (mb(base + 3) << 8) | mb(base + 4);
    v.end = ((~((mb(base + 5) << 8) | mb(base + 6))) & 0xffff) + 1;
  }
  loadHeader(v: PcmVoice): void {
    this.geom(v);
    const base = this.baseOf(v);
    v.lfo = (mb(base + 7) >> 3) & 7; v.vib = mb(base + 7) & 7;
    v.ar = mb(base + 8) >> 4; v.d1r = mb(base + 8) & 15;
    v.dl = mb(base + 9) >> 4; v.d2r = mb(base + 9) & 15;
    v.rc = mb(base + 10) >> 4; v.rr = mb(base + 10) & 15;
    v.am = mb(base + 11) & 7;
  }
  calcInc(v: PcmVoice): void {
    v.baseInc = Math.pow(2, <f64>v.oct) * (1 + <f64>v.fn / 1024);
  }

  write(reg: i32, data0: i32): void {
    const data = data0 & 0xff;
    if (reg == 0x02) { this.hdrSel = (data >> 2) & 7; return; }
    if (reg == 0x03) { this.memAddr = (this.memAddr & 0x00ffff) | ((data & 0x3f) << 16); return; }
    if (reg == 0x04) { this.memAddr = (this.memAddr & 0x3f00ff) | (data << 8); return; }
    if (reg == 0x05) { this.memAddr = (this.memAddr & 0x3fff00) | data; return; }
    if (reg == 0x06) {
      if (this.memAddr >= RAM_BASE && this.memAddr < MEM_SIZE) store<u8>(MEM_PTR + <usize>this.memAddr, <u8>data);
      this.memAddr = (this.memAddr + 1) & MEM_MASK;
      return;
    }
    if (reg < 0x08 || reg > 0xf7) return;

    const grp = (reg - 8) / 24, n = (reg - 8) % 24;
    const v = this.v[n];
    switch (grp) {
      case 0:
        v.wave = (v.wave & 0x100) | data;
        this.loadHeader(v);
        break;
      case 1: {
        const w = (v.wave & 0xff) | ((data & 1) << 8);
        v.fn = (v.fn & 0x380) | (data >> 1);
        this.calcInc(v);
        if (w != v.wave) { v.wave = w; this.loadHeader(v); }
        break;
      }
      case 2: {
        v.fn = (v.fn & 0x07f) | ((data & 7) << 7);
        v.prvb = (data >> 3) & 1;
        const o = data >> 4; v.oct = o >= 8 ? o - 16 : o;
        this.calcInc(v);
        break;
      }
      case 3:
        v.tl = data >> 1; v.ld = data & 1;
        if (v.ld) v.tlCur = v.tl;
        break;
      case 4: {
        const k = (data & 0x80) != 0;
        v.damp = (data & 0x40) != 0;
        if (data & 0x20) v.lfoPh = 0;
        v.pan = data & 15;
        if (k && !v.key) {
          if (!v.active) { v.gL = 0; v.gR = 0; }
          this.geom(v);
          v.pos = 0; v.att = 1023; v.state = 0; v.active = true; v.tlCur = v.tl;
        } else if (!k && v.key) {
          v.state = 3;
        }
        v.key = k;
        break;
      }
      case 5: v.lfo = (data >> 3) & 7; v.vib = data & 7; break;
      case 6: v.ar = data >> 4; v.d1r = data & 15; break;
      case 7: v.dl = data >> 4; v.d2r = data & 15; break;
      case 8: v.rc = data >> 4; v.rr = data & 15; break;
      case 9: v.am = data & 7; break;
      default: break;
    }
  }

  rateOf(v: PcmVoice, reg: i32): i32 {
    if (reg == 0) return 0;
    if (reg == 15) return 63;
    let r = reg << 2;
    if (v.rc != 15) r += (v.oct + v.rc) * 2 + ((v.fn & 0x200) ? 1 : 0);
    return r < 0 ? 0 : r > 63 ? 63 : r;
  }

  wrapIdx(v: PcmVoice, n: i32): i32 {
    if (n < 0) return 0;
    if (n >= v.end) {
      const span = v.end - v.loop;
      return span > 0 ? v.loop + ((n - v.end) % span) : v.end - 1;
    }
    return n;
  }

  smp(v: PcmVoice, n: i32): f64 {
    const a = v.start;
    if (v.fmt == 0) return <f64>(((mb(a + n) << 24) >> 24) << 8);
    if (v.fmt == 1) {
      const base = a + (n >> 1) * 3;
      const b1 = mb(base + 1);
      if (n & 1) return <f64>((((mb(base + 2) << 8) | ((b1 & 0x0f) << 4)) << 16) >> 16);
      return <f64>((((mb(base) << 8) | (b1 & 0xf0)) << 16) >> 16);
    }
    if (v.fmt == 2) {
      const base = a + n * 2;
      return <f64>((((mb(base) << 8) | mb(base + 1)) << 16) >> 16);
    }
    return 0;
  }

  generate(): void {
    let L: f64 = 0, R: f64 = 0;
    for (let i = 0; i < 24; i++) {
      const v = unchecked(this.v[i]);
      if (!v.active) continue;

      let inc = v.baseInc, amAtt: f64 = 0;
      if (v.vib || v.am) {
        v.lfoPh += LFO_HZ[v.lfo] / this.rate;
        if (v.lfoPh >= 1) v.lfoPh -= 1;
        const p = v.lfoPh;
        const tri = p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
        if (v.vib) inc *= Math.pow(2, VIB_CENTS[v.vib] * tri / 1200);
        if (v.am) amAtt = (tri + 1) * 0.5 * AM_UNITS[v.am];
      }

      let att = v.att;
      switch (v.state) {
        case 0: {
          const r = this.rateOf(v, v.ar);
          if (r > 0) {
            if ((r >> 2) >= 15) att = 0;
            else { att -= att * RATE_ATK[r]; if (att < 0.5) att = 0; }
          }
          if (att <= 0) { att = 0; v.state = 1; }
          break;
        }
        case 1: {
          att += 2 * RATE_DEC[this.rateOf(v, v.d1r)];
          const dl = <f64>(v.dl == 15 ? 992 : v.dl << 5);
          if (att >= dl) { att = dl; v.state = 2; }
          break;
        }
        case 2:
          att += 2 * RATE_DEC[this.rateOf(v, v.d2r)];
          break;
        default:
          att += 2 * RATE_DEC[v.damp ? 58 : this.rateOf(v, v.rr)];
          break;
      }
      if (att >= 1023) { att = 1023; if (v.state == 3) { v.active = false; v.att = att; continue; } }
      v.att = att;

      if (v.tlCur != v.tl) {
        if (v.ld) v.tlCur = v.tl;
        else v.tlCur += v.tlCur < v.tl ? 1 : -1;
      }

      v.pos += inc;
      if (v.pos >= <f64>v.end) {
        if (v.loop >= v.end) v.pos = 0;
        else v.pos = <f64>v.loop + ((v.pos - <f64>v.end) % <f64>(v.end - v.loop));
      }
      const ip = <i32>v.pos, fr = v.pos - <f64>ip;
      const sa = this.smp(v, this.wrapIdx(v, ip - 1));
      const sb = this.smp(v, this.wrapIdx(v, ip));
      const sc = this.smp(v, this.wrapIdx(v, ip + 1));
      const sd = this.smp(v, this.wrapIdx(v, ip + 2));
      const smp = cubic(sa, sb, sc, sd, fr);

      const tot = att + <f64>(v.tlCur << 2) + amAtt;
      v.gL += (ampOf(tot + <f64>(PAN_L[v.pan] * 4)) - v.gL) * 0.2;
      v.gR += (ampOf(tot + <f64>(PAN_R[v.pan] * 4)) - v.gR) * 0.2;
      L += smp * v.gL;
      R += smp * v.gR;
    }
    this.outL = L; this.outR = R;
  }
}

// =====================================================================
//  チップ (リサンプラ + ミキサ)
// =====================================================================
const SINC_TAPS: i32 = 48;
const SINC_PHASES: i32 = 256;
const SINC_BETA: f64 = 7.5;
const sincCache = new Map<i32, Float64Array>();

function getSincTable(fc: f64): Float64Array {
  const key = <i32>Math.round(fc * 100000);
  if (sincCache.has(key)) return sincCache.get(key);
  const T = SINC_TAPS, P = SINC_PHASES, half = T / 2;
  const tab = new Float64Array((P + 1) * T);
  const i0b = besselI0(SINC_BETA);
  for (let p = 0; p <= P; p++) {
    const t = <f64>p / <f64>P;
    let sum: f64 = 0;
    const row = p * T;
    for (let i = 0; i < T; i++) {
      const d = <f64>(i - (half - 1)) - t;
      const x = d / <f64>half;
      let w: f64 = 0;
      if (Math.abs(x) < 1) w = besselI0(SINC_BETA * Math.sqrt(1 - x * x)) / i0b;
      const a = Math.PI * fc * d;
      const sinc = Math.abs(a) < 1e-9 ? 1.0 : Math.sin(a) / a;
      const v = fc * sinc * w;
      tab[row + i] = v; sum += v;
    }
    for (let i = 0; i < T; i++) tab[row + i] /= sum;
  }
  sincCache.set(key, tab);
  return tab;
}

class Chip {
  isOpl4: bool = false;
  outRate: f64 = 0; nativeRate: f64 = 0; step: f64 = 0; acc: f64 = 0;
  bypass: bool = false; tab!: Float64Array; hL!: Float64Array; hR!: Float64Array; hp: i32 = 0;
  dcCoef: f64 = 0; dcL: f64 = 0; dcR: f64 = 0; prevL: f64 = 0; prevR: f64 = 0;
  oL: f64 = 0; oR: f64 = 0; nL: f64 = 0; nR: f64 = 0;
  fm!: OPL3Core; pcm: PcmCore | null = null;
  fmGL: f64 = 1; fmGR: f64 = 1; pcmGL: f64 = 1; pcmGR: f64 = 1;

  constructor(isOpl4: bool, outRate: f64, clock: f64, q: FmQ) {
    this.isOpl4 = isOpl4;
    this.outRate = outRate;
    this.nativeRate = clock / (isOpl4 ? 768.0 : 288.0);
    this.step = this.nativeRate / outRate;
    const T = SINC_TAPS;
    this.bypass = Math.abs(this.step - 1) < 1e-9;
    this.tab = getSincTable(outRate < this.nativeRate ? (outRate / this.nativeRate) * 0.955 : 0.995);
    this.hL = new Float64Array(T * 2); this.hR = new Float64Array(T * 2);
    this.dcCoef = Math.pow(0.9995, 44100 / outRate);
    this.fm = new OPL3Core(q, this.nativeRate);
    if (isOpl4) this.pcm = new PcmCore(this.nativeRate);
  }

  write(port: i32, addr0: i32, data0: i32): void {
    const addr = addr0 & 0xff, data = data0 & 0xff;
    if (!this.isOpl4) { this.fm.write(port & 1, addr, data); return; }
    if (port == 2) {
      if (addr == 0xf8) { this.fmGL = MIX_GAIN[data & 7]; this.fmGR = MIX_GAIN[(data >> 3) & 7]; return; }
      if (addr == 0xf9) { this.pcmGL = MIX_GAIN[data & 7]; this.pcmGR = MIX_GAIN[(data >> 3) & 7]; return; }
      this.pcm!.write(addr, data);
    } else {
      this.fm.write(port & 1, addr, data);
    }
  }

  nativeSample(): void {
    this.fm.generate();
    if (this.isOpl4) {
      const pcm = this.pcm!;
      pcm.generate();
      this.nL = this.fm.outL * FM_GAIN * this.fmGL + pcm.outL * PCM_GAIN * this.pcmGL;
      this.nR = this.fm.outR * FM_GAIN * this.fmGR + pcm.outR * PCM_GAIN * this.pcmGR;
    } else {
      this.nL = this.fm.outL * FM_GAIN; this.nR = this.fm.outR * FM_GAIN;
    }
  }

  renderSample(): void {
    const T = SINC_TAPS;
    this.acc += this.step;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.nativeSample();
      const p = this.hp;
      this.hL[p] = this.nL; this.hL[p + T] = this.nL;
      this.hR[p] = this.nR; this.hR[p + T] = this.nR;
      this.hp = p + 1 >= T ? 0 : p + 1;
    }
    if (this.bypass) {
      const mid = this.hp + (T >> 1) - 1;
      this.dc(this.hL[mid], this.hR[mid]);
      return;
    }
    const ph = this.acc * <f64>SINC_PHASES, pi = <i32>ph, pf = ph - <f64>pi;
    const tab = this.tab.dataStart, r0 = pi * T, r1 = r0 + T, hp = this.hp;
    const hL = this.hL.dataStart, hR = this.hR.dataStart;
    let mixL: f64 = 0, mixR: f64 = 0;
    for (let i = 0; i < T; i++) {
      const c0 = ldF64(tab, r0 + i);
      const c = c0 + (ldF64(tab, r1 + i) - c0) * pf;
      mixL += c * ldF64(hL, hp + i);
      mixR += c * ldF64(hR, hp + i);
    }
    this.dc(mixL, mixR);
  }

  dc(mixL: f64, mixR: f64): void {
    const k = this.dcCoef;
    const oL = mixL - this.prevL + k * this.dcL;
    const oR = mixR - this.prevR + k * this.dcR;
    this.prevL = mixL; this.prevR = mixR;
    this.dcL = oL; this.dcR = oR;
    this.oL = oL; this.oR = oR;
  }
}

// =====================================================================
//  公開 API
// =====================================================================
let chip262: Chip | null = null;
let chip278: Chip | null = null;

/** 4MB の ROM/RAM 領域 (JS から Uint8Array で直接書き込む) */
export function memPtr(): usize { return MEM_PTR; }
/** f64[16] 入力パラメータ (FM 音質) */
export function paramsPtr(): usize { return changetype<usize>(PARAMS); }
export function outLPtr(): usize { return changetype<usize>(OUT_L); }
export function outRPtr(): usize { return changetype<usize>(OUT_R); }
export function blockMax(): i32 { return BLOCK_MAX; }

/** params に FM 音質を書いてから呼ぶ。既存チップは破棄される */
export function createChips(outRate: f64, clock262: f64, clock278: f64): void {
  const q = readQ();
  chip262 = clock262 > 0 ? new Chip(false, outRate, clock262, q) : null;
  chip278 = clock278 > 0 ? new Chip(true, outRate, clock278, q) : null;
  memory.fill(MEM_PTR, 0, MEM_SIZE);
}
export function setQuality(): void {
  const q = readQ();
  if (chip262) chip262!.fm.setQuality(q);
  if (chip278) chip278!.fm.setQuality(q);
}
export function write262(port: i32, addr: i32, data: i32): void { if (chip262) chip262!.write(port, addr, data); }
export function write278(port: i32, addr: i32, data: i32): void { if (chip278) chip278!.write(port, addr, data); }

/** count サンプルを OUT_L / OUT_R に書き出す (両チップの合算) */
export function render(count: i32): void {
  const n = count > BLOCK_MAX ? BLOCK_MAX : count;
  const a = chip262, b = chip278;
  for (let i = 0; i < n; i++) {
    let l: f64 = 0, r: f64 = 0;
    if (a) { a.renderSample(); l += a.oL; r += a.oR; }
    if (b) { b.renderSample(); l += b.oL; r += b.oR; }
    unchecked(OUT_L[i] = l); unchecked(OUT_R[i] = r);
  }
}

// =====================================================================
//  SpatialFX (ステレオ拡張 / 初期反射 / FDN リバーブ / クロスフィード / リミッタ)
//  パラメータ導出は JS 側 (SpatialFX.set) で行い、FXP 経由で受け取る。状態と処理だけここ。
// =====================================================================
const FXP = new StaticArray<f64>(32);   // 0 enabled 1 decorrelate 2 width 3 crossfeed 4 early 5 reverb 6 limiter 7 pdLen 8 dDamp 9..16 dLen 17..24 dG
const F_OUT_L = new StaticArray<f32>(BLOCK_MAX);
const F_OUT_R = new StaticArray<f32>(BLOCK_MAX);

function nextPow2(n: i32): i32 { let p = 1; while (p < n) p <<= 1; return p; }

class Allpass {
  buf!: Float32Array; len: i32 = 0; i: i32 = 0; g: f64 = 0;
  constructor(len: i32, g: f64) { this.len = max(1, len); this.buf = new Float32Array(this.len); this.g = g; }
  @inline process(x: f64): f64 {
    const b = this.buf.dataStart, i = this.i;
    const wd = <f64>load<f32>(b + (<usize>i << 2));
    const w = x + this.g * wd;
    store<f32>(b + (<usize>i << 2), <f32>w);
    this.i = i + 1 >= this.len ? 0 : i + 1;
    return wd - this.g * w;
  }
  reset(): void { this.buf.fill(0); this.i = 0; }
}

class FX {
  sr: f64 = 0;
  outL: f64 = 0; outR: f64 = 0;
  apL: Array<Allpass> = new Array<Allpass>(); apR: Array<Allpass> = new Array<Allpass>();
  sLp: f64 = 0; mLp: f64 = 0; aSide: f64 = 0;
  erSize: i32 = 0; erMask: i32 = 0; erBufL!: Float32Array; erBufR!: Float32Array; erPos: i32 = 0;
  erDL: StaticArray<i32> = new StaticArray<i32>(6); erXL: StaticArray<i32> = new StaticArray<i32>(6); erGL: StaticArray<f64> = new StaticArray<f64>(6);
  erDR: StaticArray<i32> = new StaticArray<i32>(6); erXR: StaticArray<i32> = new StaticArray<i32>(6); erGR: StaticArray<f64> = new StaticArray<f64>(6);
  erLpL: f64 = 0; erLpR: f64 = 0; aEr: f64 = 0;
  pdSize: i32 = 0; pdMask: i32 = 0; pdL!: Float32Array; pdR!: Float32Array; pdPos: i32 = 0;
  revHpL: f64 = 0; revHpR: f64 = 0; aRevHp: f64 = 0;
  modDepth: f64 = 0; dSize: i32 = 0;
  dBuf!: Float32Array;                                  // 8 本を連結 (i * dSize)
  dPos: StaticArray<i32> = new StaticArray<i32>(8);
  dLen: StaticArray<f64> = new StaticArray<f64>(8);
  dG: StaticArray<f64> = new StaticArray<f64>(8);
  dLp: StaticArray<f64> = new StaticArray<f64>(8);
  dTmp: StaticArray<f64> = new StaticArray<f64>(8);
  dY: StaticArray<f64> = new StaticArray<f64>(8);
  lfoPh: StaticArray<f64> = new StaticArray<f64>(8);
  lfoInc: StaticArray<f64> = new StaticArray<f64>(8);
  cfLpL: f64 = 0; cfLpR: f64 = 0; aCf: f64 = 0;
  limN: i32 = 0; limL!: Float32Array; limR!: Float32Array; limI: i32 = 0; limGain: f64 = 1;
  limAtk: f64 = 0; limRel: f64 = 0; limThr: f64 = 0.84;
  // パラメータ
  enabled: bool = true; decorrelate: f64 = 0; width: f64 = 1; crossfeed: f64 = 0; early: f64 = 0; reverb: f64 = 0;
  limiter: bool = true; pdLen: i32 = 1; dDamp: f64 = 0.4;

  constructor(sr: f64) {
    this.sr = sr;
    const k = sr / 48000;
    const apLens: StaticArray<i32> = [142, 107, 379, 277], apLensR: StaticArray<i32> = [151, 113, 397, 293];
    for (let i = 0; i < 4; i++) {
      this.apL.push(new Allpass(<i32>Math.round(<f64>apLens[i] * k), 0.5));
      this.apR.push(new Allpass(<i32>Math.round(<f64>apLensR[i] * k), 0.5));
    }
    this.aSide = 1 - Math.exp(-2 * Math.PI * 160 / sr);

    this.erSize = nextPow2(<i32>Math.ceil(0.09 * sr));
    this.erMask = this.erSize - 1;
    this.erBufL = new Float32Array(this.erSize); this.erBufR = new Float32Array(this.erSize);
    const tL: StaticArray<f64> = [7.1, 12.9, 19.3, 26.7, 35.9, 47.3], tR: StaticArray<f64> = [8.9, 14.3, 21.7, 29.9, 39.1, 51.7];
    const gains: StaticArray<f64> = [.50, -.42, .34, -.28, .22, -.16];
    for (let i = 0; i < 6; i++) {
      this.erDL[i] = <i32>Math.round(tL[i] * 0.001 * sr); this.erXL[i] = i & 1; this.erGL[i] = gains[i];
      this.erDR[i] = <i32>Math.round(tR[i] * 0.001 * sr); this.erXR[i] = i & 1; this.erGR[i] = gains[i];
    }
    this.aEr = 1 - Math.exp(-2 * Math.PI * 7000 / sr);

    this.pdSize = nextPow2(<i32>Math.ceil(0.2 * sr));
    this.pdMask = this.pdSize - 1;
    this.pdL = new Float32Array(this.pdSize); this.pdR = new Float32Array(this.pdSize);
    this.aRevHp = 1 - Math.exp(-2 * Math.PI * 180 / sr);

    this.modDepth = 4 * k;
    this.dSize = <i32>Math.ceil(2731.0 * k * 1.6) + <i32>Math.ceil(this.modDepth) + 8;
    this.dBuf = new Float32Array(8 * this.dSize);
    const rates: StaticArray<f64> = [0.17, 0.23, 0.29, 0.31, 0.37, 0.41, 0.43, 0.47];
    for (let i = 0; i < 8; i++) { this.lfoPh[i] = <f64>i * 0.7; this.lfoInc[i] = 2 * Math.PI * rates[i] / sr; }

    this.aCf = 1 - Math.exp(-2 * Math.PI * 700 / sr);

    this.limN = max(2, <i32>Math.round(0.0015 * sr));
    this.limL = new Float32Array(this.limN); this.limR = new Float32Array(this.limN);
    this.limAtk = 1 - Math.exp(-1 / (0.00025 * sr));
    this.limRel = 1 - Math.exp(-1 / (0.12 * sr));
  }

  applyParams(): void {
    this.enabled = FXP[0] != 0;
    this.decorrelate = FXP[1]; this.width = FXP[2]; this.crossfeed = FXP[3];
    this.early = FXP[4]; this.reverb = FXP[5]; this.limiter = FXP[6] != 0;
    this.pdLen = <i32>FXP[7]; this.dDamp = FXP[8];
    for (let i = 0; i < 8; i++) { this.dLen[i] = FXP[9 + i]; this.dG[i] = FXP[17 + i]; }
  }

  reset(): void {
    for (let i = 0; i < 4; i++) { this.apL[i].reset(); this.apR[i].reset(); }
    this.erBufL.fill(0); this.erBufR.fill(0); this.pdL.fill(0); this.pdR.fill(0); this.dBuf.fill(0);
    for (let i = 0; i < 8; i++) this.dLp[i] = 0;
    this.limL.fill(0); this.limR.fill(0);
    this.sLp = 0; this.mLp = 0; this.erLpL = 0; this.erLpR = 0;
    this.revHpL = 0; this.revHpR = 0; this.cfLpL = 0; this.cfLpR = 0;
    this.limGain = 1;
  }

  process(inL: f64, inR: f64): void {
    if (!this.enabled) { this.outL = inL; this.outR = inR; return; }

    // 1) ステレオ拡張
    const M = (inL + inR) * 0.5, S = (inL - inR) * 0.5;
    this.sLp += (S - this.sLp) * this.aSide;
    this.mLp += (M - this.mLp) * this.aSide;
    const sHp = S - this.sLp, mHp = M - this.mLp;
    let dec: f64 = 0;
    if (this.decorrelate > 0) {
      let a = mHp, b = mHp;
      for (let i = 0; i < 4; i++) { a = unchecked(this.apL[i]).process(a); b = unchecked(this.apR[i]).process(b); }
      dec = (a - b) * 0.5 * this.decorrelate;
    }
    const S2 = this.sLp + this.width * (sHp + dec);
    let l = M + S2, r = M - S2;

    // 4) クロスフィード
    if (this.crossfeed > 0) {
      this.cfLpL += (l - this.cfLpL) * this.aCf;
      this.cfLpR += (r - this.cfLpR) * this.aCf;
      const cf = this.crossfeed, nrm = 1 / (1 + cf * 0.6);
      const l2 = (l + cf * this.cfLpR) * nrm, r2 = (r + cf * this.cfLpL) * nrm;
      l = l2; r = r2;
    }

    // 2) 初期反射
    let erL: f64 = 0, erR: f64 = 0;
    if (this.early > 0) {
      const ep = this.erPos, em = this.erMask;
      const bl = this.erBufL.dataStart, br = this.erBufR.dataStart;
      store<f32>(bl + (<usize>ep << 2), <f32>l); store<f32>(br + (<usize>ep << 2), <f32>r);
      for (let i = 0; i < 6; i++) {
        const src = unchecked(this.erXL[i]) ? br : bl;
        erL += unchecked(this.erGL[i]) * <f64>load<f32>(src + (<usize>((ep - unchecked(this.erDL[i])) & em) << 2));
      }
      for (let i = 0; i < 6; i++) {
        const src = unchecked(this.erXR[i]) ? bl : br;
        erR += unchecked(this.erGR[i]) * <f64>load<f32>(src + (<usize>((ep - unchecked(this.erDR[i])) & em) << 2));
      }
      this.erPos = (ep + 1) & em;
      this.erLpL += (erL - this.erLpL) * this.aEr; erL = this.erLpL;
      this.erLpR += (erR - this.erLpR) * this.aEr; erR = this.erLpR;
    }

    // 3) FDN リバーブ
    let wetL: f64 = 0, wetR: f64 = 0;
    if (this.reverb > 0) {
      this.revHpL += (l - this.revHpL) * this.aRevHp;
      this.revHpR += (r - this.revHpR) * this.aRevHp;
      const pp = this.pdPos, pm = this.pdMask;
      const pl = this.pdL.dataStart, pr = this.pdR.dataStart;
      store<f32>(pl + (<usize>pp << 2), <f32>(l - this.revHpL));
      store<f32>(pr + (<usize>pp << 2), <f32>(r - this.revHpR));
      const rp = (pp - this.pdLen) & pm;
      const xl = <f64>load<f32>(pl + (<usize>rp << 2)), xr = <f64>load<f32>(pr + (<usize>rp << 2));
      this.pdPos = (pp + 1) & pm;

      const damp = this.dDamp, ia = 1 - damp, size = this.dSize;
      const db = this.dBuf.dataStart;
      for (let i = 0; i < 8; i++) {
        const base = db + (<usize>(i * size) << 2);
        const mod = this.modDepth * Math.sin(unchecked(this.lfoPh[i]));
        let ph = unchecked(this.lfoPh[i]) + unchecked(this.lfoInc[i]);
        if (ph > 6.283185307179586) ph -= 6.283185307179586;
        unchecked(this.lfoPh[i] = ph);
        let pos = <f64>unchecked(this.dPos[i]) - (unchecked(this.dLen[i]) + mod);
        while (pos < 0) pos += <f64>size;
        const i0 = <i32>pos, fr = pos - <f64>i0;
        const i1 = i0 + 1 >= size ? 0 : i0 + 1;
        const b0 = <f64>load<f32>(base + (<usize>i0 << 2));
        const v = b0 + (<f64>load<f32>(base + (<usize>i1 << 2)) - b0) * fr;
        unchecked(this.dY[i] = v);
        const lp = ia * v + damp * unchecked(this.dLp[i]);
        unchecked(this.dLp[i] = lp);
        unchecked(this.dTmp[i] = lp * unchecked(this.dG[i]));
      }
      const tmp = this.dTmp;
      for (let h = 1; h < 8; h <<= 1) {
        for (let i = 0; i < 8; i += h << 1) {
          for (let j = i; j < i + h; j++) { const a = unchecked(tmp[j]), b = unchecked(tmp[j + h]); unchecked(tmp[j] = a + b); unchecked(tmp[j + h] = a - b); }
        }
      }
      const IN = 0.9, SC = 0.35355339059327373;
      for (let i = 0; i < 8; i++) {
        const base = db + (<usize>(i * size) << 2);
        const dp = unchecked(this.dPos[i]);
        store<f32>(base + (<usize>dp << 2), <f32>(unchecked(tmp[i]) * SC + ((i & 1) ? xr : xl) * IN));
        unchecked(this.dPos[i] = dp + 1 >= size ? 0 : dp + 1);
      }
      const y = this.dY;
      wetL = (unchecked(y[0]) + unchecked(y[2]) + unchecked(y[4]) + unchecked(y[6])) * 0.5;
      wetR = (unchecked(y[1]) + unchecked(y[3]) + unchecked(y[5]) + unchecked(y[7])) * 0.5;
    }

    let oL = l + this.early * erL + this.reverb * wetL;
    let oR = r + this.early * erR + this.reverb * wetR;

    // 5) リミッタ
    if (this.limiter) {
      const peak = Math.max(Math.abs(oL), Math.abs(oR));
      const target = peak > this.limThr ? this.limThr / peak : 1;
      this.limGain += (target - this.limGain) * (target < this.limGain ? this.limAtk : this.limRel);
      const li = this.limI;
      const dl = <f64>this.limL[li], dr = <f64>this.limR[li];
      this.limL[li] = <f32>oL; this.limR[li] = <f32>oR;
      this.limI = li + 1 >= this.limN ? 0 : li + 1;
      oL = dl * this.limGain; oR = dr * this.limGain;
    }
    this.outL = oL; this.outR = oR;
  }
}

function softOut(x: f64): f64 {
  const T = 0.85;
  if (x > T) return T + (1 - T) * Math.tanh((x - T) / (1 - T));
  if (x < -T) return -T - (1 - T) * Math.tanh((-x - T) / (1 - T));
  return x;
}

let fx: FX | null = null;

export function fxParamsPtr(): usize { return changetype<usize>(FXP); }
export function fOutLPtr(): usize { return changetype<usize>(F_OUT_L); }
export function fOutRPtr(): usize { return changetype<usize>(F_OUT_R); }
/** sr 用に FX を(再)生成。直後に FXP を書いて fxApply() を呼ぶこと */
export function fxInit(sr: f64): void { fx = new FX(sr); }
export function fxApply(): void { if (fx) fx!.applyParams(); }
export function fxReset(): void { if (fx) fx!.reset(); }

/** OUT_L/OUT_R (チップ出力) → FX → ソフトクリップ → F_OUT_L/R (f32) */
export function fxRun(count: i32): void {
  const f = fx!;
  const n = count > BLOCK_MAX ? BLOCK_MAX : count;
  for (let i = 0; i < n; i++) {
    f.process(unchecked(OUT_L[i]), unchecked(OUT_R[i]));
    unchecked(F_OUT_L[i] = <f32>softOut(f.outL));
    unchecked(F_OUT_R[i] = <f32>softOut(f.outR));
  }
}
/** 無音入力で FX だけ回す (停止中の残響) */
export function fxSilence(count: i32): void {
  const f = fx!;
  const n = count > BLOCK_MAX ? BLOCK_MAX : count;
  for (let i = 0; i < n; i++) {
    f.process(0, 0);
    unchecked(F_OUT_L[i] = <f32>softOut(f.outL));
    unchecked(F_OUT_R[i] = <f32>softOut(f.outR));
  }
}
