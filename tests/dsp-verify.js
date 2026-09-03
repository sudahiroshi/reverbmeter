/**
 * dsp-verify.js - ピンクTSP / 逆フィルタ / IR算出 の数値検証スクリプト
 *
 * ブラウザに依存しないDSPロジックをNodeで実行して検証する。
 *   実行: node tests/dsp-verify.js
 *
 * js/*.js はブラウザ向けのIIFEモジュールなので、vmで同一グローバルに読み込む。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
for (const file of ['js/fft.js', 'js/pink-tsp.js', 'js/audio-utils.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
    checks++;
    const mark = condition ? 'PASS' : 'FAIL';
    if (!condition) failures++;
    console.log(`  [${mark}] ${label}${detail ? ' : ' + detail : ''}`);
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function db(x) {
    return 20 * Math.log10(Math.max(Math.abs(x), 1e-300));
}

/** 再現性のある擬似乱数 (線形合同法) */
function makeRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296 * 2 - 1;
    };
}

// =====================================================================
section('1. FFT の自己検証');
// =====================================================================
{
    const n = 1024;
    const rand = makeRandom(1);
    const src = new Float64Array(n);
    for (let i = 0; i < n; i++) src[i] = rand();

    const { re, im } = FFT.toComplex(src, n);
    FFT.forward(re, im);
    FFT.inverse(re, im);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - src[i]));
    check('FFT→IFFT の往復誤差 < 1e-10', maxErr < 1e-10, `max err = ${maxErr.toExponential(3)}`);

    // 既知の正弦波: 周波数ビンにのみエネルギーが立つ
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.cos(2 * Math.PI * 64 * i / n);
    const spec = FFT.magnitudeSpectrum(sig, n);
    let argmax = 0;
    for (let k = 0; k < spec.mags.length; k++) if (spec.mags[k] > spec.mags[argmax]) argmax = k;
    check('64周期の余弦波のピークがビン64', argmax === 64, `argmax = ${argmax}`);
}

// =====================================================================
section('2. ピンクTSPのスペクトル特性 (受入基準1)');
// =====================================================================
function measureSlope(sampleRate, opts) {
    const tsp = PinkTSP.generate(sampleRate, opts);
    const { freqs, mags } = FFT.magnitudeSpectrum(tsp.signal, sampleRate);

    // 帯域端のテーパーを避けて f1*2 〜 f2/2 の範囲をオクターブ帯域で平均する
    const lo = tsp.params.startFreq * 2;
    const hi = tsp.params.endFreq / 2;
    const points = [];
    for (let fc = lo; fc <= hi; fc *= 2) {
        const fLo = fc / Math.SQRT2;
        const fHi = fc * Math.SQRT2;
        let sum = 0, count = 0;
        for (let k = 1; k < freqs.length; k++) {
            if (freqs[k] >= fLo && freqs[k] < fHi) { sum += mags[k] * mags[k]; count++; }
        }
        if (count > 0) points.push({ fc, levelDb: 10 * Math.log10(sum / count) });
    }

    // log2(f) に対する最小二乗直線の傾き = dB/oct
    const x = points.map(p => Math.log2(p.fc));
    const y = points.map(p => p.levelDb);
    const reg = AudioUtils.linearRegression(x, y);
    return { tsp, points, slope: reg.slope, r2: reg.r2 };
}

{
    for (const sr of [44100, 48000]) {
        const { tsp, points, slope, r2 } = measureSlope(sr, {});
        console.log(`  sampleRate=${sr}: N=${tsp.length} (${tsp.params.durationSec.toFixed(3)}s), ` +
            `f1=${tsp.params.startFreq}Hz, f2=${tsp.params.endFreq}Hz`);
        console.log('    オクターブ帯域の平均パワー: ' +
            points.map(p => `${p.fc.toFixed(0)}Hz:${p.levelDb.toFixed(2)}dB`).join(', '));
        check(`スペクトル傾斜が -3dB/oct ±0.3 (${sr}Hz)`,
            Math.abs(slope + 3.0) < 0.3, `slope = ${slope.toFixed(3)} dB/oct, R² = ${r2.toFixed(4)}`);
    }

    // 参考: オクターブあたりのエネルギーが一定であること
    const { tsp } = measureSlope(48000, {});
    const { freqs, mags } = FFT.magnitudeSpectrum(tsp.signal, 48000);
    const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
    const energies = bands.map(fc => {
        let sum = 0;
        for (let k = 1; k < freqs.length; k++) {
            if (freqs[k] >= fc / Math.SQRT2 && freqs[k] < fc * Math.SQRT2) sum += mags[k] * mags[k];
        }
        return { fc, db: 10 * Math.log10(sum) };
    });
    const ref = energies[0].db;
    const spread = Math.max(...energies.map(e => Math.abs(e.db - ref)));
    console.log('    オクターブ帯域エネルギー: ' +
        energies.map(e => `${e.fc}Hz:${(e.db - ref).toFixed(2)}dB`).join(', '));
    check('オクターブあたりのエネルギー偏差 < 0.5dB', spread < 0.5, `max偏差 = ${spread.toFixed(3)} dB`);
}

// =====================================================================
section('3. ピンクTSP × 逆フィルタ = 単一インパルス (受入基準2)');
// =====================================================================
function impulseResidual(tsp, guardSec) {
    const inv = PinkTSP.getInverseFilter(tsp);
    const y = FFT.circularConvolve(tsp.signal, inv);

    let peakIdx = 0, peak = 0;
    for (let i = 0; i < y.length; i++) {
        if (Math.abs(y[i]) > peak) { peak = Math.abs(y[i]); peakIdx = i; }
    }
    const guard = Math.max(1, Math.round(guardSec * tsp.sampleRate));
    let residual = 0;
    for (let i = 0; i < y.length; i++) {
        if (Math.abs(i - peakIdx) <= guard) continue;
        residual = Math.max(residual, Math.abs(y[i]));
    }
    return { peakIdx, peak, residual, residualDb: db(residual / peak), guard, length: y.length };
}

{
    const sr = 48000;
    const tsp = PinkTSP.generate(sr, {});
    const r = impulseResidual(tsp, 0.0005); // ピーク±0.5msをガード区間として除外
    console.log(`  既定設定 (f1=${tsp.params.startFreq}Hz, f2=${tsp.params.endFreq}Hz, N=${tsp.length})`);
    console.log(`    ピーク位置 = ${r.peakIdx} (期待 ${tsp.length / 2}), ガード = ±${r.guard}サンプル`);
    check('ピークが逆フィルタの群遅延位置 N/2 に立つ', r.peakIdx === tsp.length / 2, `peak = ${r.peakIdx}`);
    check('ガード区間外の残差 ≤ -40dB', r.residualDb <= -40, `残差 = ${r.residualDb.toFixed(2)} dB`);

    // 全帯域設計 (帯域制限による主ローブが無い場合) では残差は数値誤差レベルまで下がる
    const full = PinkTSP.generate(sr, { startFreq: 20, endFreq: sr / 2 * 0.95, edgeOctaves: 4 });
    const rf = impulseResidual(full, 0.0005);
    console.log(`  広帯域設定 (f1=${full.params.startFreq}Hz, f2=${full.params.endFreq.toFixed(0)}Hz)`);
    check('広帯域設定でもガード区間外の残差 ≤ -40dB', rf.residualDb <= -40,
        `残差 = ${rf.residualDb.toFixed(2)} dB`);
}

// =====================================================================
section('4. 既知の合成IRからの復元 (受入基準3)');
// =====================================================================
/**
 * 合成インパルス応答を作る: 直接音 + 反射音 + 指数減衰する拡散音
 */
function makeSyntheticIR(sampleRate, { rt60 = 0.6, directDelay = 500, reflectionDelay = 1000, reflectionGain = 0.5 } = {}) {
    const len = Math.round(sampleRate * rt60 * 1.5);
    const h = new Float64Array(len);
    const rand = makeRandom(12345);
    const decay = Math.log(10) * 3 / (rt60 * sampleRate); // 60dB/rt60 の指数減衰
    for (let i = directDelay; i < len; i++) {
        h[i] = 0.25 * rand() * Math.exp(-decay * (i - directDelay));
    }
    h[directDelay] = 1.0;                                    // 直接音
    h[reflectionDelay] += reflectionGain;                    // 反射音
    return { h, directDelay, reflectionDelay, reflectionGain, rt60 };
}

/**
 * TSPを繰り返し再生して合成IRの部屋で録音した状況を模擬する
 * targetPeak: 実際の録音に近い振幅へ正規化する
 */
function simulateRecording(tsp, h, { latency = 3000, noiseLevel = 0, targetPeak = 0.3 } = {}) {
    const n = tsp.length;
    const reps = tsp.params.averages + 1;
    const playLen = reps * n;

    const played = new Float64Array(playLen);
    for (let i = 0; i < playLen; i++) played[i] = tsp.signal[i % n];

    const y = FFT.convolve(played, h);
    let maxAbs = 0;
    for (let i = 0; i < y.length; i++) maxAbs = Math.max(maxAbs, Math.abs(y[i]));
    const gain = maxAbs > 0 ? targetPeak / maxAbs : 1;

    const rand = makeRandom(999);
    const rec = new Float32Array(playLen);
    for (let i = 0; i < playLen; i++) {
        const src = i - latency;
        let v = (src >= 0 && src < y.length) ? y[src] * gain : 0;
        if (noiseLevel > 0) v += noiseLevel * rand();
        rec[i] = v;
    }
    return rec;
}

/**
 * 合成IRをTSPと同じ帯域に制限した参照IRを作る
 * (ピンクTSPで測れるのは f1〜f2 の帯域だけなので、比較対象も帯域制限する)
 */
function bandlimitedReference(h, tsp) {
    const n = tsp.length;
    // TSP × 逆フィルタ = 帯域制限デルタ (ピークは N/2)
    const g = FFT.circularConvolve(tsp.signal, PinkTSP.getInverseFilter(tsp));
    const hp = new Float64Array(n);
    for (let i = 0; i < Math.min(h.length, n); i++) hp[i] = h[i];
    const y = FFT.circularConvolve(hp, g);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = y[(i + n / 2) % n]; // N/2の遅延を戻す
    return out;
}

{
    const sr = 48000;
    const tsp = PinkTSP.generate(sr, { averages: 2 });
    const synth = makeSyntheticIR(sr, { rt60: 0.6 });
    const rec = simulateRecording(tsp, synth.h, { latency: 3000 });

    const result = PinkTSP.extractImpulseResponse(rec, tsp);
    const ir = result.samples;

    console.log(`  同期加算 = ${result.blocksUsed}周期, 入力レベル = ${result.inputLevelDbfs.toFixed(1)} dBFS, ` +
        `ノイズフロア = ${result.noiseFloorDb.toFixed(1)} dB`);

    // ピーク位置: プリディレイ (5ms) の位置に直接音が来る
    check('直接音がプリディレイ位置に整列する', result.peakIndex === Math.round(0.005 * sr),
        `peakIndex = ${result.peakIndex}`);

    // 帯域制限した参照IR (ピークを1に正規化) と比較する
    const ref = bandlimitedReference(synth.h, tsp);
    const refPeak = Math.abs(ref[synth.directDelay]);

    // 反射音の相対位置が保存されているか
    const relOffset = synth.reflectionDelay - synth.directDelay;
    let reflIdx = 0, reflVal = 0;
    for (let i = result.peakIndex + 50; i < result.peakIndex + relOffset * 2; i++) {
        if (Math.abs(ir[i]) > reflVal) { reflVal = Math.abs(ir[i]); reflIdx = i; }
    }
    const refRefl = Math.abs(ref[synth.reflectionDelay]) / refPeak;
    check('反射音のピーク位置が一致 (誤差1サンプル以内)',
        Math.abs((reflIdx - result.peakIndex) - relOffset) <= 1,
        `推定 ${reflIdx - result.peakIndex} サンプル / 真値 ${relOffset} サンプル`);
    check('反射音の振幅比が参照IRと一致 (誤差1%以内)',
        Math.abs(reflVal - refRefl) / refRefl < 0.01,
        `推定 ${reflVal.toFixed(4)} / 参照 ${refRefl.toFixed(4)} (帯域制限前の設計値 ${(synth.h[synth.reflectionDelay]).toFixed(4)})`);

    // 減衰の傾き: 合成IRと復元IRのSchroeder積分から求めたRT60を比較
    const trueIR = synth.h.slice(synth.directDelay);
    const trueEdc = AudioUtils.schroederIntegration(Float32Array.from(trueIR));
    const trueRt = AudioUtils.calculateRT60(trueEdc, sr, 'RT30');

    const estIR = ir.slice(result.peakIndex, result.decayEndIndex);
    const estEdc = AudioUtils.schroederIntegration(estIR);
    const estRt = AudioUtils.calculateRT60(estEdc, sr, 'RT30');

    console.log(`  合成IRのRT60 = ${trueRt.rt60}s (設計値 ${synth.rt60}s), 復元IRのRT60 = ${estRt.rt60}s`);
    check('復元IRのRT60が合成IRと一致 (誤差2%以内)',
        Math.abs(estRt.rt60 - trueRt.rt60) / trueRt.rt60 < 0.02,
        `差 = ${(Math.abs(estRt.rt60 - trueRt.rt60) / trueRt.rt60 * 100).toFixed(2)} %`);

    // 波形そのものの一致度 (直接音から0.3秒間の相関)
    const cmpLen = Math.round(sr * 0.3);
    function correlation(getA, getB) {
        let num = 0, da = 0, db2 = 0;
        for (let i = 0; i < cmpLen; i++) {
            const a = getA(i), b = getB(i);
            num += a * b; da += a * a; db2 += b * b;
        }
        return num / Math.sqrt(da * db2);
    }
    const corrRef = correlation(i => ir[result.peakIndex + i], i => ref[synth.directDelay + i]);
    const corrRaw = correlation(i => ir[result.peakIndex + i], i => synth.h[synth.directDelay + i]);
    check('復元IRと帯域制限参照IRの相関係数 > 0.999', corrRef > 0.999, `corr = ${corrRef.toFixed(6)}`);
    console.log(`  (参考) 帯域制限前の合成IRとの相関 = ${corrRaw.toFixed(5)} ` +
        `- 40Hz〜16kHz帯域外を測っていないぶん低くなる`);

    // ノイズを載せた場合でも破綻しないこと
    const noisyRec = simulateRecording(tsp, synth.h, { latency: 3000, noiseLevel: 0.001 });
    const noisyResult = PinkTSP.extractImpulseResponse(noisyRec, tsp);
    const noisyRt = AudioUtils.calculateRT60(
        AudioUtils.schroederIntegration(noisyResult.samples.slice(noisyResult.peakIndex, noisyResult.decayEndIndex)),
        sr, 'RT30');
    check('雑音付き録音でもRT60が誤差5%以内',
        Math.abs(noisyRt.rt60 - trueRt.rt60) / trueRt.rt60 < 0.05,
        `RT60 = ${noisyRt.rt60}s (S/N = ${noisyResult.snrDb.toFixed(1)}dB)`);
}

// =====================================================================
section('5. サンプリングレート違いでの動作 (44.1kHz)');
// =====================================================================
{
    const sr = 44100;
    const tsp = PinkTSP.generate(sr, { averages: 1 });
    const synth = makeSyntheticIR(sr, { rt60: 0.45 });
    const rec = simulateRecording(tsp, synth.h, { latency: 2048 });
    const result = PinkTSP.extractImpulseResponse(rec, tsp);
    const estRt = AudioUtils.calculateRT60(
        AudioUtils.schroederIntegration(result.samples.slice(result.peakIndex, result.decayEndIndex)),
        sr, 'RT30');
    check('44.1kHzでもRT60が設計値と一致 (誤差5%以内)',
        Math.abs(estRt.rt60 - 0.45) / 0.45 < 0.05, `RT60 = ${estRt.rt60}s`);
}

// =====================================================================
section('6. エッジケース');
// =====================================================================
{
    const sr = 48000;
    const tsp = PinkTSP.generate(sr, { averages: 2 });
    const n = tsp.length;

    // 無音
    try {
        PinkTSP.extractImpulseResponse(new Float32Array(n * 3), tsp);
        check('無音の録音でエラーを返す', false, '例外が発生しなかった');
    } catch (e) {
        check('無音の録音でエラーを返す', /録音レベル/.test(e.message), e.message);
    }

    // 極小レベル (-80dBFS相当)
    try {
        const tiny = new Float32Array(n * 3);
        const rand = makeRandom(7);
        for (let i = 0; i < tiny.length; i++) tiny[i] = rand() * 1e-4;
        PinkTSP.extractImpulseResponse(tiny, tsp);
        check('極小レベルの録音でエラーを返す', false, '例外が発生しなかった');
    } catch (e) {
        check('極小レベルの録音でエラーを返す', /録音レベル/.test(e.message), e.message);
    }

    // 録音長が不足
    try {
        PinkTSP.extractImpulseResponse(new Float32Array(n), tsp);
        check('録音長不足でエラーを返す', false, '例外が発生しなかった');
    } catch (e) {
        check('録音長不足でエラーを返す', /録音長/.test(e.message), e.message);
    }

    // 録音長が指定より短い (2周期だけある場合は加算数を減らして継続)
    {
        const synth = makeSyntheticIR(sr, { rt60: 0.4 });
        const rec = simulateRecording(tsp, synth.h, { latency: 1000 });
        const short = rec.slice(0, n * 2);
        const result = PinkTSP.extractImpulseResponse(short, tsp);
        check('2周期しかない録音でも1周期で解析を継続', result.blocksUsed === 1,
            `blocksUsed = ${result.blocksUsed}`);
    }

    // クリッピング
    {
        const synth = makeSyntheticIR(sr, { rt60: 0.4 });
        const rec = simulateRecording(tsp, synth.h, { latency: 1000 });
        let maxAbs = 0;
        for (let i = 0; i < rec.length; i++) maxAbs = Math.max(maxAbs, Math.abs(rec[i]));
        const clipped = new Float32Array(rec.length);
        for (let i = 0; i < rec.length; i++) {
            clipped[i] = Math.max(-1, Math.min(1, rec[i] / maxAbs * 3)); // 強制的に飽和させる
        }
        const result = PinkTSP.extractImpulseResponse(clipped, tsp);
        check('クリッピングを検出してフラグを立てる', result.clipped === true,
            `クリップ率 = ${(result.clippingRatio * 100).toFixed(2)} %`);
        check('クリッピングしていても解析は完走する', result.samples.length === n,
            `IR長 = ${result.samples.length}`);
    }
}

// =====================================================================
console.log(`\n----------------------------------------`);
console.log(`検証項目: ${checks} 件 / 失敗: ${failures} 件`);
process.exit(failures === 0 ? 0 : 1);
