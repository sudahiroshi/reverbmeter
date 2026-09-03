/**
 * fft.js - 基数2 FFT (外部ライブラリ非依存)
 * ピンクTSPの設計とデコンボリューションに使用する
 */

const FFT = (() => {
    // 回転因子とビット反転表のキャッシュ (同じ長さのFFTを繰り返すため)
    const tableCache = new Map();

    /**
     * n以上の最小の2の冪を返す
     * @param {number} n
     * @returns {number}
     */
    function nextPow2(n) {
        let p = 1;
        while (p < n) p *= 2;
        return p;
    }

    function isPow2(n) {
        return n > 0 && (n & (n - 1)) === 0;
    }

    function getTables(n) {
        let t = tableCache.get(n);
        if (t) return t;

        const levels = Math.round(Math.log2(n));
        const cosTable = new Float64Array(n / 2);
        const sinTable = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            cosTable[i] = Math.cos(2 * Math.PI * i / n);
            sinTable[i] = Math.sin(2 * Math.PI * i / n);
        }

        // ビット反転順のインデックス表
        const rev = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            let x = i;
            let r = 0;
            for (let b = 0; b < levels; b++) {
                r = (r << 1) | (x & 1);
                x >>= 1;
            }
            rev[i] = r;
        }

        t = { cosTable, sinTable, rev, levels };
        tableCache.set(n, t);
        return t;
    }

    /**
     * 順方向FFT (in-place, 符号は exp(-j2πkn/N))
     * @param {Float64Array} re
     * @param {Float64Array} im
     */
    function forward(re, im) {
        const n = re.length;
        if (n !== im.length) throw new Error('FFT: 実部と虚部の長さが一致しません');
        if (!isPow2(n)) throw new Error('FFT: 長さは2の冪である必要があります');
        if (n === 1) return;

        const { cosTable, sinTable, rev } = getTables(n);

        // ビット反転並べ替え
        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) {
                let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
                tmp = im[i]; im[i] = im[j]; im[j] = tmp;
            }
        }

        // バタフライ演算
        for (let size = 2; size <= n; size *= 2) {
            const halfsize = size / 2;
            const tablestep = n / size;
            for (let i = 0; i < n; i += size) {
                for (let j = i, k = 0; j < i + halfsize; j++, k += tablestep) {
                    const l = j + halfsize;
                    const tpre = re[l] * cosTable[k] + im[l] * sinTable[k];
                    const tpim = -re[l] * sinTable[k] + im[l] * cosTable[k];
                    re[l] = re[j] - tpre;
                    im[l] = im[j] - tpim;
                    re[j] += tpre;
                    im[j] += tpim;
                }
            }
        }
    }

    /**
     * 逆FFT (in-place, 1/N のスケーリング込み)
     * @param {Float64Array} re
     * @param {Float64Array} im
     */
    function inverse(re, im) {
        const n = re.length;
        // 実部と虚部を入れ替えて順変換すると逆変換になる
        forward(im, re);
        for (let i = 0; i < n; i++) {
            re[i] /= n;
            im[i] /= n;
        }
    }

    /**
     * 実信号をゼロ詰めして複素配列に変換
     * @param {Float32Array|Float64Array|number[]} signal
     * @param {number} n - FFT長 (2の冪)
     * @returns {{ re: Float64Array, im: Float64Array }}
     */
    function toComplex(signal, n) {
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        const len = Math.min(signal.length, n);
        for (let i = 0; i < len; i++) re[i] = signal[i];
        return { re, im };
    }

    /**
     * 線形畳み込み (FFTによる高速畳み込み)
     * @param {Float32Array|Float64Array} a
     * @param {Float32Array|Float64Array} b
     * @returns {Float64Array} 長さ a.length + b.length - 1
     */
    function convolve(a, b) {
        const outLen = a.length + b.length - 1;
        const n = nextPow2(outLen);
        const A = toComplex(a, n);
        const B = toComplex(b, n);
        forward(A.re, A.im);
        forward(B.re, B.im);
        for (let i = 0; i < n; i++) {
            const re = A.re[i] * B.re[i] - A.im[i] * B.im[i];
            const im = A.re[i] * B.im[i] + A.im[i] * B.re[i];
            A.re[i] = re;
            A.im[i] = im;
        }
        inverse(A.re, A.im);
        return A.re.slice(0, outLen);
    }

    /**
     * 巡回畳み込み (長さnの2信号)
     * @param {Float32Array|Float64Array} a
     * @param {Float32Array|Float64Array} b
     * @returns {Float64Array} 長さ n
     */
    function circularConvolve(a, b) {
        const n = a.length;
        if (b.length !== n) throw new Error('巡回畳み込み: 長さが一致しません');
        const A = toComplex(a, n);
        const B = toComplex(b, n);
        forward(A.re, A.im);
        forward(B.re, B.im);
        for (let i = 0; i < n; i++) {
            const re = A.re[i] * B.re[i] - A.im[i] * B.im[i];
            const im = A.re[i] * B.im[i] + A.im[i] * B.re[i];
            A.re[i] = re;
            A.im[i] = im;
        }
        inverse(A.re, A.im);
        return A.re;
    }

    /**
     * 実信号の片側振幅スペクトルを返す
     * @param {Float32Array|Float64Array} signal
     * @param {number} sampleRate
     * @returns {{ freqs: Float64Array, mags: Float64Array }}
     */
    function magnitudeSpectrum(signal, sampleRate) {
        const n = nextPow2(signal.length);
        const { re, im } = toComplex(signal, n);
        forward(re, im);
        const half = n / 2;
        const freqs = new Float64Array(half + 1);
        const mags = new Float64Array(half + 1);
        for (let k = 0; k <= half; k++) {
            freqs[k] = k * sampleRate / n;
            mags[k] = Math.hypot(re[k], im[k]);
        }
        return { freqs, mags };
    }

    return {
        nextPow2,
        isPow2,
        forward,
        inverse,
        toComplex,
        convolve,
        circularConvolve,
        magnitudeSpectrum
    };
})();

// Node.js から検証スクリプトで読み込めるようにする (ブラウザでは無視される)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FFT;
}
