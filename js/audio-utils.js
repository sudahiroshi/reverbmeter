/**
 * audio-utils.js - 音響計算ユーティリティ
 * Schroeder積分、フィルタ、線形回帰など
 */

const AudioUtils = (() => {
  /**
   * オクターブバンド中心周波数 (Hz)
   */
  const OCTAVE_BANDS = [125, 250, 500, 1000, 2000, 4000];

  /**
   * オクターブバンドフィルタを作成
   * @param {AudioContext} ctx
   * @param {number} centerFreq - 中心周波数 (Hz)
   * @returns {BiquadFilterNode}
   */
  function createBandpassFilter(ctx, centerFreq) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = centerFreq;
    // 1オクターブバンドのQ値 ≈ 1.414
    filter.Q.value = 1.414;
    return filter;
  }

  /**
   * 信号にバンドパスフィルタを適用
   * @param {Float32Array} signal
   * @param {number} sampleRate
   * @param {number} centerFreq
   * @returns {Float32Array}
   */
  function applyBandpassFilter(signal, sampleRate, centerFreq) {
    const ctx = new OfflineAudioContext(1, signal.length, sampleRate);
    const buffer = ctx.createBuffer(1, signal.length, sampleRate);
    buffer.getChannelData(0).set(signal);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = createBandpassFilter(ctx, centerFreq);
    source.connect(filter);
    filter.connect(ctx.destination);
    source.start(0);
    return ctx.startRendering().then(renderedBuffer => {
      return renderedBuffer.getChannelData(0);
    });
  }

  /**
   * Schroeder積分 (後方積分) でエネルギー減衰曲線(EDC)を計算
   * @param {Float32Array} signal - インパルス応答
   * @returns {Float32Array} - dBスケールのEDC
   */
  function schroederIntegration(signal) {
    const n = signal.length;
    const edc = new Float32Array(n);

    // 二乗して後方から累積和
    let sum = 0;
    for (let i = n - 1; i >= 0; i--) {
      sum += signal[i] * signal[i];
      edc[i] = sum;
    }

    // dBに変換 (最大値で正規化)
    const maxVal = edc[0];
    if (maxVal <= 0) return edc;

    for (let i = 0; i < n; i++) {
      if (edc[i] > 0) {
        edc[i] = 10 * Math.log10(edc[i] / maxVal);
      } else {
        edc[i] = -120; // ノイズフロア
      }
    }

    return edc;
  }

  /**
   * 線形回帰 (最小二乗法)
   * @param {number[]} x
   * @param {number[]} y
   * @returns {{ slope: number, intercept: number, r2: number }}
   */
  function linearRegression(x, y) {
    const n = x.length;
    if (n === 0) return { slope: 0, intercept: 0, r2: 0 };

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    // R²
    const meanY = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      ssTot += (y[i] - meanY) ** 2;
      ssRes += (y[i] - (slope * x[i] + intercept)) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    return { slope, intercept, r2 };
  }

  /**
   * EDCからRT60を計算 (RT20外挿 or RT30外挿)
   * @param {Float32Array} edc - dBスケールのEDC
   * @param {number} sampleRate
   * @param {string} method - 'RT20' or 'RT30'
   * @returns {{ rt60: number, edt: number, regression: object, valid: boolean }}
   */
  function calculateRT60(edc, sampleRate, method = 'RT20') {
    const n = edc.length;

    // EDCの開始点を探す (最大値付近、-5dB地点)
    let startIdx = 0;
    let endIdx = n - 1;

    // -5dBポイントを探す
    for (let i = 0; i < n; i++) {
      if (edc[i] <= -5) {
        startIdx = i;
        break;
      }
    }

    // RT20: -5dB 〜 -25dB → ×3で外挿
    // RT30: -5dB 〜 -35dB → ×2で外挿
    const dropDB = method === 'RT30' ? 30 : 20;
    const targetDB = -5 - dropDB;
    const multiplier = 60 / dropDB;

    for (let i = startIdx; i < n; i++) {
      if (edc[i] <= targetDB) {
        endIdx = i;
        break;
      }
    }

    // startIdx〜endIdxの区間で線形回帰
    if (endIdx <= startIdx) {
      return { rt60: NaN, edt: NaN, regression: null, valid: false };
    }

    const xData = [];
    const yData = [];
    for (let i = startIdx; i <= endIdx; i++) {
      xData.push(i / sampleRate);
      yData.push(edc[i]);
    }

    const reg = linearRegression(xData, yData);

    // 傾きから60dB減衰に必要な時間を計算
    let rt60 = NaN;
    if (reg.slope < 0) {
      rt60 = -60 / reg.slope;
    }

    // EDT: 0dB 〜 -10dBの傾きから計算
    let edt = NaN;
    let edtStartIdx = 0;
    let edtEndIdx = 0;
    for (let i = 0; i < n; i++) {
      if (edc[i] <= -10) {
        edtEndIdx = i;
        break;
      }
    }

    if (edtEndIdx > edtStartIdx) {
      const edtX = [];
      const edtY = [];
      for (let i = edtStartIdx; i <= edtEndIdx; i++) {
        edtX.push(i / sampleRate);
        edtY.push(edc[i]);
      }
      const edtReg = linearRegression(edtX, edtY);
      if (edtReg.slope < 0) {
        edt = -60 / edtReg.slope;
      }
    }

    return {
      rt60: isFinite(rt60) ? Math.round(rt60 * 1000) / 1000 : NaN,
      edt: isFinite(edt) ? Math.round(edt * 1000) / 1000 : NaN,
      regression: reg,
      valid: reg.r2 > 0.8 && isFinite(rt60) && rt60 > 0
    };
  }

  /**
   * 振幅からdBに変換
   * @param {number} amplitude
   * @returns {number}
   */
  function amplitudeToDb(amplitude) {
    return 20 * Math.log10(Math.max(amplitude, 1e-10));
  }

  /**
   * RMS (Root Mean Square) を計算
   * @param {Float32Array} signal
   * @returns {number}
   */
  function calculateRMS(signal) {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
      sum += signal[i] * signal[i];
    }
    return Math.sqrt(sum / signal.length);
  }

  /**
   * インパルス応答の開始点を自動検出 (閾値ベース)
   * @param {Float32Array} signal
   * @param {number} thresholdDb - 検出閾値 (dB)
   * @returns {number} 開始サンプルインデックス
   */
  function detectImpulseStart(signal, thresholdDb = -20) {
    const rms = calculateRMS(signal);
    const threshold = rms * Math.pow(10, thresholdDb / 20) * 10;

    for (let i = 0; i < signal.length; i++) {
      if (Math.abs(signal[i]) > threshold) {
        // 少し手前から返す
        return Math.max(0, i - 10);
      }
    }
    return 0;
  }

  /**
   * EDCを時間軸データにダウンサンプリング (描画用)
   * @param {Float32Array} edc
   * @param {number} sampleRate
   * @param {number} maxPoints
   * @returns {{ times: number[], values: number[] }}
   */
  function downsampleEDC(edc, sampleRate, maxPoints = 500) {
    const step = Math.max(1, Math.floor(edc.length / maxPoints));
    const times = [];
    const values = [];

    for (let i = 0; i < edc.length; i += step) {
      times.push(Math.round(i / sampleRate * 1000) / 1000); // 秒
      values.push(Math.round(edc[i] * 10) / 10); // dB (小数1位)
    }

    return { times, values };
  }

  /**
   * IR波形を描画用にダウンサンプリング
   * 各区間で絶対値が最大のサンプルを代表値にして、ピークを潰さずに間引く
   * @param {Float32Array} ir
   * @param {number} sampleRate
   * @param {number} maxPoints
   * @returns {{ times: number[], values: number[] }}
   */
  function downsampleIRWaveform(ir, sampleRate, maxPoints = 800) {
    const step = Math.max(1, Math.floor(ir.length / maxPoints));
    const times = [];
    const values = [];

    for (let i = 0; i < ir.length; i += step) {
      const end = Math.min(i + step, ir.length);
      let peak = 0;
      let peakIdx = i;
      for (let j = i; j < end; j++) {
        if (Math.abs(ir[j]) > peak) {
          peak = Math.abs(ir[j]);
          peakIdx = j;
        }
      }
      times.push(Math.round(peakIdx / sampleRate * 100000) / 100000);
      values.push(Math.round(ir[peakIdx] * 10000) / 10000);
    }

    return { times, values };
  }

  /**
   * IRのdB表示用データ (区間RMSのdBエンベロープ + Schroeder積分曲線)
   * @param {Float32Array} ir
   * @param {number} sampleRate
   * @param {number} maxPoints
   * @returns {{ times: number[], envelope: number[], schroeder: number[] }}
   */
  function buildIRDbCurve(ir, sampleRate, maxPoints = 600) {
    const step = Math.max(1, Math.floor(ir.length / maxPoints));
    const edc = schroederIntegration(ir);

    // 区間RMSを求め、最大値を0dBとして正規化する
    const rmsValues = [];
    const indices = [];
    let maxRms = 0;
    for (let i = 0; i < ir.length; i += step) {
      const end = Math.min(i + step, ir.length);
      let sum = 0;
      for (let j = i; j < end; j++) sum += ir[j] * ir[j];
      const rms = Math.sqrt(sum / (end - i));
      if (rms > maxRms) maxRms = rms;
      rmsValues.push(rms);
      indices.push(i);
    }

    const times = [];
    const envelope = [];
    const schroeder = [];
    const ref = maxRms > 0 ? maxRms : 1;
    for (let k = 0; k < rmsValues.length; k++) {
      times.push(Math.round(indices[k] / sampleRate * 100000) / 100000);
      const db = 20 * Math.log10(Math.max(rmsValues[k] / ref, 1e-6));
      envelope.push(Math.round(db * 10) / 10);
      schroeder.push(Math.round(edc[indices[k]] * 10) / 10);
    }

    return { times, envelope, schroeder };
  }

  return {
    OCTAVE_BANDS,
    createBandpassFilter,
    applyBandpassFilter,
    schroederIntegration,
    linearRegression,
    calculateRT60,
    amplitudeToDb,
    calculateRMS,
    detectImpulseStart,
    downsampleEDC,
    downsampleIRWaveform,
    buildIRDbCurve
  };
})();
