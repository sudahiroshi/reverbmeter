/**
 * pink-tsp.js - ピンクTSP (pink-weighted Time-Stretched Pulse) の生成と
 *               逆フィルタによるインパルス応答(IR)の算出
 *
 * 設計方針:
 *   - 周波数領域で振幅 |H(f)| ∝ 1/√f (パワー ∝ 1/f = ピンク特性, -3dB/oct) を与える
 *   - 群遅延を累積エネルギーに比例させる (定常位相近似) ことで、
 *     低域ほど長い時間をかけて掃引し、全帯域で均一なS/Nを得る
 *   - 白色TSPは高域にエネルギーが偏るため、室内測定では低域のS/Nが不足しやすい。
 *     ピンク特性にすることでオクターブあたりのエネルギーが一定になり、
 *     スピーカーの過大入力も避けやすくなる
 *   - 逆フィルタは正則化付きの逆特性 conj(H)/(|H|²+ε)。帯域外を持ち上げないため
 *     ノイズに強い
 */

const PinkTSP = (() => {
    /**
     * 既定パラメータ (UIから上書き可能。ハードコードを避けるためここに集約する)
     */
    const DEFAULTS = {
        durationSec: 3,      // 目標信号長(秒)。内部でFFTに適した2の冪サンプルへ丸める
        startFreq: 40,       // 掃引開始周波数 f1 (Hz)
        endFreq: 16000,      // 掃引終了周波数 f2 (Hz)
        averages: 2,         // 同期加算回数 (加算する周期数)
        edgeOctaves: 1.0,    // 帯域端のレイズドコサインテーパー幅 (オクターブ)
        sweepStartRatio: 0.02, // 掃引開始時刻 (信号長に対する比)
        sweepEndRatio: 0.92,   // 掃引終了時刻 (信号長に対する比)
        regularization: 1e-6,  // 逆フィルタの正則化係数 (最大パワーに対する比)
        playbackGain: 0.5    // 再生ゲイン
    };

    // 解析パラメータ
    const PRE_DELAY_SEC = 0.005;    // IRの直接音の手前に残す時間(秒)
    const SILENCE_RMS_DBFS = -70;   // これ以下の録音レベルは無音とみなす
    const CLIP_LEVEL = 0.99;        // クリッピング判定レベル
    const CLIP_RATIO_WARN = 0.001;  // クリップ率がこれを超えたら警告
    const NOISE_MARGIN_DB = 5;      // 減衰打ち切り判定のノイズフロアマージン
    const MIN_DECAY_SEC = 0.05;     // 減衰打ち切りの最小長(秒)

    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    /**
     * 指定サンプル数に最も近い2の冪を返す (最小 4096)
     * @param {number} samples
     * @returns {number}
     */
    function nearestPow2(samples) {
        const exp = Math.round(Math.log2(Math.max(samples, 1)));
        return Math.pow(2, Math.max(12, exp));
    }

    /**
     * 帯域端のレイズドコサインテーパー (対数周波数軸で滑らかに0へ)
     * 急峻に打ち切ると逆フィルタ適用後のインパルスに長いリンギングが残るため、
     * 通過域の外側を滑らかに減衰させる
     * @param {number} f - 周波数(Hz)
     * @param {number} f1 - 通過域下限
     * @param {number} f2 - 通過域上限
     * @param {number} lowOct - 下側テーパー幅(オクターブ)
     * @param {number} highOct - 上側テーパー幅(オクターブ)
     * @returns {number} 0〜1の重み
     */
    function edgeTaper(f, f1, f2, lowOct, highOct) {
        if (f >= f1 && f <= f2) return 1;
        if (f < f1) {
            if (lowOct <= 0) return 0;
            const x = Math.log2(f1 / f) / lowOct; // 0(=f1) → 1(=テーパー端)
            if (x >= 1) return 0;
            return 0.5 * (1 + Math.cos(Math.PI * x));
        }
        if (highOct <= 0) return 0;
        const x = Math.log2(f / f2) / highOct;
        if (x >= 1) return 0;
        return 0.5 * (1 + Math.cos(Math.PI * x));
    }

    /**
     * ピンクTSPと逆フィルタを生成する
     * @param {number} sampleRate
     * @param {object} options - DEFAULTS を上書きするパラメータ
     * @returns {object} TSP一式 (signal / 逆フィルタスペクトル / パラメータ)
     */
    function generate(sampleRate, options = {}) {
        const cfg = Object.assign({}, DEFAULTS, options);

        // FFTに適した2の冪長へ丸める (指定長に最も近い長さを選ぶ)
        const n = nearestPow2(sampleRate * cfg.durationSec);
        const half = n / 2;
        const df = sampleRate / n;
        const nyquist = sampleRate / 2;

        // 周波数範囲をサンプリングレートに合わせて安全な範囲へ収める
        const f2 = clamp(cfg.endFreq, 200, nyquist * 0.95);
        const f1 = clamp(cfg.startFreq, df * 4, f2 / 4);

        // テーパーがナイキストや最低ビンで打ち切られないように幅を制限する
        const highOct = Math.min(cfg.edgeOctaves, Math.log2(nyquist / f2));
        const lowOct = Math.min(cfg.edgeOctaves, Math.log2(f1 / df));

        // --- 振幅特性: ピンク (パワー ∝ 1/f) ---
        const amp = new Float64Array(half + 1);
        let maxAmp = 0;
        for (let k = 1; k < half; k++) {
            const f = k * df;
            const w = edgeTaper(f, f1, f2, lowOct, highOct);
            if (w <= 0) continue;
            amp[k] = w / Math.sqrt(f); // |H| ∝ 1/√f → パワー ∝ 1/f
            if (amp[k] > maxAmp) maxAmp = amp[k];
        }

        // --- 群遅延: 累積エネルギーに比例させる (定常位相近似) ---
        const cum = new Float64Array(half + 1);
        let acc = 0;
        for (let k = 0; k <= half; k++) {
            acc += amp[k] * amp[k];
            cum[k] = acc;
        }
        const totalEnergy = cum[half] > 0 ? cum[half] : 1;
        const tStart = cfg.sweepStartRatio * n / sampleRate;
        const tSpan = (cfg.sweepEndRatio - cfg.sweepStartRatio) * n / sampleRate;

        const groupDelay = new Float64Array(half + 1);
        for (let k = 0; k <= half; k++) {
            groupDelay[k] = tStart + tSpan * (cum[k] / totalEnergy);
        }

        // 群遅延 τ(f) = -(1/2π)dφ/df を台形則で積分して位相を得る
        const phase = new Float64Array(half + 1);
        for (let k = 1; k <= half; k++) {
            phase[k] = phase[k - 1] - 2 * Math.PI * df * (groupDelay[k] + groupDelay[k - 1]) / 2;
        }

        // --- 複素スペクトルを構成してIFFTで時間波形を得る ---
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        for (let k = 1; k < half; k++) {
            if (amp[k] === 0) continue;
            const a = amp[k];
            const p = phase[k];
            re[k] = a * Math.cos(p);
            im[k] = a * Math.sin(p);
            // エルミート対称 (実信号)
            re[n - k] = re[k];
            im[n - k] = -im[k];
        }
        // DC と ナイキストは 0 (直流成分と折り返し点を持たせない)

        const specRe = Float64Array.from(re);
        const specIm = Float64Array.from(im);

        FFT.inverse(re, im);

        // 振幅を ±1 に正規化
        let peak = 0;
        for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(re[i]));
        const scale = peak > 0 ? 1 / peak : 1;
        const signal = new Float32Array(n);
        for (let i = 0; i < n; i++) signal[i] = re[i] * scale;

        // --- 逆フィルタ: conj(H)/(|H|²+ε) ---
        const eps = cfg.regularization * maxAmp * maxAmp;
        const invRe = new Float64Array(n);
        const invIm = new Float64Array(n);
        for (let k = 1; k < half; k++) {
            const a = amp[k];
            if (a === 0) continue;
            const denom = a * a + eps;
            // 生成時に振幅を scale 倍したので逆フィルタ側で戻す
            const g = a / denom / scale;
            invRe[k] = g * Math.cos(-phase[k]);
            invIm[k] = g * Math.sin(-phase[k]);
            invRe[n - k] = invRe[k];
            invIm[n - k] = -invIm[k];
        }

        return {
            signal,
            length: n,
            sampleRate,
            spectrum: { re: specRe, im: specIm },
            inverseSpectrum: { re: invRe, im: invIm },
            params: {
                durationSec: n / sampleRate,
                requestedDurationSec: cfg.durationSec,
                startFreq: f1,
                endFreq: f2,
                averages: Math.max(1, Math.round(cfg.averages)),
                edgeOctaves: cfg.edgeOctaves,
                lowEdgeOctaves: lowOct,
                highEdgeOctaves: highOct,
                playbackGain: cfg.playbackGain,
                signalType: 'pink-tsp'
            }
        };
    }

    /**
     * 逆フィルタを時間波形として取り出す (検証・保存用)
     * 群遅延 n/2 を加えて因果的な位置にそろえる
     * @param {object} tsp - generate() の戻り値
     * @returns {Float64Array} 長さ n。畳み込むとピークは index n/2 に立つ
     */
    function getInverseFilter(tsp) {
        const n = tsp.length;
        const re = Float64Array.from(tsp.inverseSpectrum.re);
        const im = Float64Array.from(tsp.inverseSpectrum.im);
        // exp(-j2πk(n/2)/n) = (-1)^k を掛けて n/2 サンプル遅延させる
        for (let k = 0; k < n; k++) {
            if (k % 2 === 1) {
                re[k] = -re[k];
                im[k] = -im[k];
            }
        }
        FFT.inverse(re, im);
        return re;
    }

    /**
     * 逆フィルタを周波数領域で適用してIRを得る (巡回デコンボリューション)
     * @param {Float32Array|Float64Array} block - TSP1周期分の応答 (長さ n)
     * @param {object} tsp
     * @returns {Float64Array} 長さ n の巡回インパルス応答
     */
    function deconvolve(block, tsp) {
        const n = tsp.length;
        if (block.length !== n) throw new Error('デコンボリューション: 長さが一致しません');

        const { re, im } = FFT.toComplex(block, n);
        FFT.forward(re, im);

        const ir = tsp.inverseSpectrum;
        for (let k = 0; k < n; k++) {
            const r = re[k] * ir.re[k] - im[k] * ir.im[k];
            const i = re[k] * ir.im[k] + im[k] * ir.re[k];
            re[k] = r;
            im[k] = i;
        }

        FFT.inverse(re, im);
        return re;
    }

    /**
     * 録音データから定常状態の周期を同期加算する
     * TSPを繰り返し再生すると、2周期目以降の応答は周期nで定常になる。
     * 先頭1周期を捨てることで再生・録音間のレイテンシに依存せず加算できる。
     * @param {Float32Array} recorded
     * @param {object} tsp
     * @returns {{ block: Float64Array, blocksUsed: number }}
     */
    function averagePeriods(recorded, tsp) {
        const n = tsp.length;
        const available = Math.floor(recorded.length / n) - 1; // 先頭1周期は過渡状態なので除外
        if (available < 1) {
            throw new Error('録音長が信号長に対して不足しています (最低2周期必要)');
        }
        const blocksUsed = Math.min(available, tsp.params.averages);

        const block = new Float64Array(n);
        for (let b = 0; b < blocksUsed; b++) {
            const offset = (b + 1) * n;
            for (let i = 0; i < n; i++) {
                block[i] += recorded[offset + i];
            }
        }
        for (let i = 0; i < n; i++) block[i] /= blocksUsed;

        return { block, blocksUsed };
    }

    /**
     * RMSを計算
     */
    function rms(signal, from = 0, to = signal.length) {
        let sum = 0;
        const len = to - from;
        if (len <= 0) return 0;
        for (let i = from; i < to; i++) sum += signal[i] * signal[i];
        return Math.sqrt(sum / len);
    }

    /**
     * クリッピングしているサンプルの割合
     */
    function clippingRatio(signal) {
        let count = 0;
        for (let i = 0; i < signal.length; i++) {
            if (Math.abs(signal[i]) >= CLIP_LEVEL) count++;
        }
        return signal.length > 0 ? count / signal.length : 0;
    }

    /**
     * 減衰がノイズフロアに埋もれる位置を推定する (Schroeder積分の打ち切り用)
     * @param {Float32Array|Float64Array} ir
     * @param {number} sampleRate
     * @param {number} peakIndex
     * @returns {number} 打ち切りインデックス
     */
    function estimateDecayEnd(ir, sampleRate, peakIndex) {
        const win = Math.max(16, Math.round(0.01 * sampleRate)); // 10ms窓
        const winCount = Math.floor(ir.length / win);
        if (winCount < 10) return ir.length;

        const env = new Float64Array(winCount);
        for (let w = 0; w < winCount; w++) {
            env[w] = rms(ir, w * win, (w + 1) * win);
        }

        // 末尾10%をノイズフロアとみなす
        const tailStart = Math.floor(winCount * 0.9);
        let noise = 0;
        for (let w = tailStart; w < winCount; w++) noise += env[w];
        noise /= (winCount - tailStart);

        if (noise <= 0) return ir.length;
        const threshold = noise * Math.pow(10, NOISE_MARGIN_DB / 20);

        const minIndex = peakIndex + Math.round(MIN_DECAY_SEC * sampleRate);
        const startWin = Math.floor(minIndex / win);
        for (let w = startWin; w < winCount; w++) {
            if (env[w] < threshold) return Math.min(ir.length, (w + 1) * win);
        }
        return ir.length;
    }

    /**
     * 録音信号からインパルス応答を算出する
     * @param {Float32Array} recorded - TSPを (averages+1) 回再生した間の録音
     * @param {object} tsp - generate() の戻り値
     * @returns {object} IRと付随情報
     */
    function extractImpulseResponse(recorded, tsp) {
        const n = tsp.length;
        const sampleRate = tsp.sampleRate;

        const { block, blocksUsed } = averagePeriods(recorded, tsp);

        const levelRms = rms(block);
        const levelDbfs = 20 * Math.log10(Math.max(levelRms, 1e-12));
        if (levelDbfs < SILENCE_RMS_DBFS) {
            throw new Error(`録音レベルが低すぎます (${levelDbfs.toFixed(1)} dBFS)。マイクの入力を確認してください`);
        }

        const clipRatio = clippingRatio(recorded);

        // 巡回デコンボリューション
        const raw = deconvolve(block, tsp);

        // 直接音のピーク位置を探し、プリディレイを残して先頭へそろえる
        let peakIndex = 0;
        let peakValue = 0;
        for (let i = 0; i < n; i++) {
            const v = Math.abs(raw[i]);
            if (v > peakValue) {
                peakValue = v;
                peakIndex = i;
            }
        }
        if (!(peakValue > 0)) {
            throw new Error('インパルス応答を検出できませんでした');
        }

        const preDelay = Math.round(PRE_DELAY_SEC * sampleRate);
        const shift = (peakIndex - preDelay + n) % n;

        const ir = new Float32Array(n);
        const invPeak = 1 / peakValue;
        for (let i = 0; i < n; i++) {
            ir[i] = raw[(shift + i) % n] * invPeak; // ピークを1に正規化
        }

        const decayEnd = estimateDecayEnd(ir, sampleRate, preDelay);

        // ノイズフロア (ピーク比dB)
        const noiseRms = rms(ir, Math.floor(n * 0.9), n);
        const noiseFloorDb = 20 * Math.log10(Math.max(noiseRms, 1e-12));

        return {
            samples: ir,
            sampleRate,
            peakIndex: preDelay,
            peakAmplitude: peakValue,
            decayEndIndex: decayEnd,
            blocksUsed,
            inputLevelDbfs: levelDbfs,
            clippingRatio: clipRatio,
            clipped: clipRatio > CLIP_RATIO_WARN,
            noiseFloorDb,
            snrDb: -noiseFloorDb,
            params: tsp.params
        };
    }

    return {
        DEFAULTS,
        PRE_DELAY_SEC,
        generate,
        getInverseFilter,
        deconvolve,
        averagePeriods,
        extractImpulseResponse,
        estimateDecayEnd
    };
})();

// Node.js から検証スクリプトで読み込めるようにする (ブラウザでは無視される)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PinkTSP;
}
