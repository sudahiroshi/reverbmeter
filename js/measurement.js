/**
 * measurement.js - 測定エンジン
 * マイク入力、インパルス応答録音、ピンクTSP測定
 */

const Measurement = (() => {
    let audioCtx = null;
    let mediaStream = null;
    let sourceNode = null;
    let analyserNode = null;
    let scriptNode = null;
    let isRecording = false;
    let isMeasuring = false;
    let recordedChunks = [];
    let recordedSamples = [];
    let measurementMode = 'impulse'; // 'impulse' or 'tsp'
    let lastTsp = null;              // 直近に生成したピンクTSP (逆フィルタを保持)
    let levelCallback = null;
    let statusCallback = null;
    let waveformCallback = null;

    // 録音設定
    const SAMPLE_RATE = 44100;
    const MAX_RECORD_SECONDS = 10;
    const IMPULSE_THRESHOLD = 0.15; // インパルス検出閾値
    const SILENCE_THRESHOLD = 0.005; // 静寂検出閾値
    const SILENCE_DURATION = 1.5; // 静寂持続時間(秒)

    /**
     * マイクを初期化
     * @returns {Promise<{ok: boolean, reason?: string, errorName?: string}>}
     *   失敗時の reason は 'insecure' | 'denied' | 'not-found' | 'other'
     */
    async function initMicrophone() {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: SAMPLE_RATE
                }
            });

            audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE
            });

            // ブラウザポリシーにより suspended になる場合があるため明示的にresume
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            sourceNode = audioCtx.createMediaStreamSource(mediaStream);

            // アナライザー設定
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 2048;
            analyserNode.smoothingTimeConstant = 0.3;
            sourceNode.connect(analyserNode);

            console.log('マイク初期化成功: sampleRate =', audioCtx.sampleRate, ', state =', audioCtx.state);
            return { ok: true };
        } catch (err) {
            console.error('マイクの初期化に失敗:', err);
            return { ok: false, reason: classifyMicError(err), errorName: err && err.name };
        }
    }

    /**
     * マイク初期化の失敗を、利用者に案内する原因の区分に分ける
     */
    function classifyMicError(err) {
        // 非セキュアコンテキストでは navigator.mediaDevices 自体が無く TypeError になるため先に判定する
        if (!window.isSecureContext) return 'insecure';
        switch (err && err.name) {
            case 'NotAllowedError':
            case 'PermissionDeniedError':
            case 'SecurityError':
                return 'denied';
            case 'NotFoundError':
            case 'DevicesNotFoundError':
                return 'not-found';
            default:
                return 'other';
        }
    }

    /**
     * マイクを停止
     */
    function stopMicrophone() {
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        if (audioCtx) {
            audioCtx.close();
            audioCtx = null;
        }
        sourceNode = null;
        analyserNode = null;
        scriptNode = null;
    }

    /**
     * リアルタイムレベルメーターを開始
     */
    function startLevelMeter(callback) {
        levelCallback = callback;
        if (!analyserNode) return;

        const dataArray = new Float32Array(analyserNode.fftSize);

        function updateLevel() {
            if (!analyserNode || !levelCallback) return;

            analyserNode.getFloatTimeDomainData(dataArray);

            // RMS計算
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i] * dataArray[i];
            }
            const rms = Math.sqrt(sum / dataArray.length);
            const db = AudioUtils.amplitudeToDb(rms);

            levelCallback(db, rms);

            // 波形コールバック
            if (waveformCallback) {
                waveformCallback(dataArray);
            }

            requestAnimationFrame(updateLevel);
        }

        updateLevel();
    }

    /**
     * 波形コールバックを設定
     */
    function setWaveformCallback(callback) {
        waveformCallback = callback;
    }

    /**
     * ステータスコールバック設定
     */
    function setStatusCallback(callback) {
        statusCallback = callback;
    }

    /**
     * インパルス応答方式の測定を開始
     */
    async function startImpulseMeasurement() {
        if (!audioCtx || !sourceNode) {
            const mic = await initMicrophone();
            if (!mic.ok) return null;
        }

        // AudioContextが suspended の場合は resume
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        return new Promise((resolve, reject) => {
            isMeasuring = true;
            isRecording = false;
            recordedSamples = [];

            const bufferSize = 4096;
            scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);

            let silenceSamples = 0;
            const silenceThresholdSamples = SILENCE_DURATION * audioCtx.sampleRate;
            let totalSamples = 0;
            const maxSamples = MAX_RECORD_SECONDS * audioCtx.sampleRate;
            let triggered = false;
            let preTriggerBuffer = [];
            const preTriggerSize = Math.floor(audioCtx.sampleRate * 0.1); // 0.1秒分のプレトリガー

            if (statusCallback) statusCallback('waiting');

            scriptNode.onaudioprocess = (e) => {
                // 出力は無音のまま (マイク入力をスピーカーへ返すと自分の音を再録音してしまう)
                const inputData = e.inputBuffer.getChannelData(0);

                if (!isMeasuring) return;

                // プレトリガーバッファに追加
                for (let i = 0; i < inputData.length; i++) {
                    preTriggerBuffer.push(inputData[i]);
                }
                if (preTriggerBuffer.length > preTriggerSize) {
                    preTriggerBuffer = preTriggerBuffer.slice(-preTriggerSize);
                }

                // インパルス検出
                if (!triggered) {
                    for (let i = 0; i < inputData.length; i++) {
                        if (Math.abs(inputData[i]) > IMPULSE_THRESHOLD) {
                            triggered = true;
                            isRecording = true;

                            if (statusCallback) statusCallback('recording');

                            // プレトリガーデータを含めて録音開始
                            recordedSamples.push(...preTriggerBuffer);

                            // 残りのサンプルを追加
                            for (let j = i; j < inputData.length; j++) {
                                recordedSamples.push(inputData[j]);
                            }
                            totalSamples = recordedSamples.length;
                            return;
                        }
                    }
                } else {
                    // 録音中のサンプル追加
                    for (let i = 0; i < inputData.length; i++) {
                        recordedSamples.push(inputData[i]);
                        totalSamples++;

                        // 静寂検出
                        if (Math.abs(inputData[i]) < SILENCE_THRESHOLD) {
                            silenceSamples++;
                        } else {
                            silenceSamples = 0;
                        }
                    }

                    // 静寂が続いたら終了
                    if (silenceSamples >= silenceThresholdSamples || totalSamples >= maxSamples) {
                        finishRecording(resolve);
                    }
                }
            };

            sourceNode.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);

            // タイムアウト (最大録音時間)
            setTimeout(() => {
                if (isMeasuring && triggered) {
                    finishRecording(resolve);
                } else if (isMeasuring && !triggered) {
                    stopMeasurement();
                    resolve(null);
                }
            }, (MAX_RECORD_SECONDS + 5) * 1000);
        });
    }

    /**
     * 録音を完了し結果を処理
     */
    async function finishRecording(resolve) {
        isMeasuring = false;
        isRecording = false;

        if (scriptNode) {
            scriptNode.disconnect();
            scriptNode = null;
        }

        if (statusCallback) statusCallback('processing');

        const rawData = new Float32Array(recordedSamples);
        const sampleRate = audioCtx ? audioCtx.sampleRate : SAMPLE_RATE;

        // 非同期で解析を実行
        try {
            const result = await analyzeImpulseResponse(rawData, sampleRate);
            if (statusCallback) statusCallback('done');
            resolve(result);
        } catch (err) {
            console.error('解析エラー:', err);
            if (statusCallback) statusCallback('done');
            resolve(null);
        }
    }

    /**
     * ピンクTSP方式の測定を開始
     * TSPを (同期加算回数 + 2) 周期くり返し再生し、定常状態の周期を同期加算してから
     * 逆フィルタでデコンボリューションしてインパルス応答を得る。
     * 先頭1周期を捨てることで、再生と録音のレイテンシが未知でも整合がとれる。
     * @param {object} options - PinkTSP.DEFAULTS を上書きするパラメータ
     * @returns {Promise<object>} 解析結果
     */
    async function startPinkTspMeasurement(options = {}) {
        if (!audioCtx || !sourceNode) {
            const mic = await initMicrophone();
            if (!mic.ok) throw new Error('マイクを初期化できませんでした');
        }

        // AudioContextが suspended の場合は resume
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        const sampleRate = audioCtx.sampleRate;
        const tsp = PinkTSP.generate(sampleRate, options);
        lastTsp = tsp;

        // 解析に必要な録音長 = (同期加算回数 + 1) 周期
        const requiredSamples = (tsp.params.averages + 1) * tsp.length;
        // 再生はさらに1周期多くして、レイテンシで末尾が欠けないようにする
        const playRepeats = tsp.params.averages + 2;

        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            const recordBuffer = new Float32Array(requiredSamples);
            let writeIndex = 0;

            const playBuffer = audioCtx.createBuffer(1, playRepeats * tsp.length, sampleRate);
            const playData = playBuffer.getChannelData(0);
            for (let r = 0; r < playRepeats; r++) {
                playData.set(tsp.signal, r * tsp.length);
            }

            const tspSource = audioCtx.createBufferSource();
            tspSource.buffer = playBuffer;

            const gainNode = audioCtx.createGain();
            gainNode.gain.value = tsp.params.playbackGain;
            tspSource.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            isMeasuring = true;
            isRecording = true;

            const bufferSize = 4096;
            scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);

            function cleanup() {
                isRecording = false;
                isMeasuring = false;
                if (timeoutId) clearTimeout(timeoutId);
                try { tspSource.stop(); } catch (e) { /* 再生済みなら無視 */ }
                tspSource.disconnect();
                gainNode.disconnect();
                if (scriptNode) {
                    scriptNode.disconnect();
                    scriptNode.onaudioprocess = null;
                    scriptNode = null;
                }
            }

            async function finish() {
                if (settled) return;
                settled = true;
                cleanup();

                if (statusCallback) statusCallback('processing');

                try {
                    const recorded = recordBuffer.subarray(0, writeIndex);
                    const ir = PinkTSP.extractImpulseResponse(recorded, tsp);
                    const results = await analyzeIR(
                        ir.samples.subarray(ir.peakIndex, ir.decayEndIndex),
                        sampleRate,
                        { method: 'pink-tsp', ir }
                    );
                    if (statusCallback) statusCallback('done');
                    resolve(results);
                } catch (err) {
                    if (statusCallback) statusCallback('idle');
                    reject(err);
                }
            }

            scriptNode.onaudioprocess = (e) => {
                // 出力は無音にする (マイク入力をスピーカーへ返すとハウリングし測定が壊れる)
                const inputData = e.inputBuffer.getChannelData(0);
                if (!isRecording) return;

                const remaining = requiredSamples - writeIndex;
                if (remaining <= 0) return;
                const count = Math.min(remaining, inputData.length);
                recordBuffer.set(inputData.subarray(0, count), writeIndex);
                writeIndex += count;

                if (writeIndex >= requiredSamples) {
                    isRecording = false;
                    finish();
                }
            };

            sourceNode.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);

            tspSource.start(0);
            if (statusCallback) statusCallback('tsp-playing');

            // 再生が終わっても必要サンプル数に届かない場合の保険
            const timeoutMs = (playBuffer.duration + 3) * 1000;
            timeoutId = setTimeout(() => {
                if (settled) return;
                isRecording = false;
                if (writeIndex >= 2 * tsp.length) {
                    finish();
                } else {
                    settled = true;
                    cleanup();
                    if (statusCallback) statusCallback('idle');
                    reject(new Error('録音データが不足しました。マイクの状態を確認してください'));
                }
            }, timeoutMs);
        });
    }

    /**
     * インパルス応答方式(手拍子など)の録音を解析
     */
    function analyzeImpulseResponse(rawData, sampleRate) {
        if (!rawData || rawData.length === 0) return null;

        // インパルス開始点を検出
        const startIdx = AudioUtils.detectImpulseStart(rawData);
        const irData = rawData.slice(startIdx);

        // 手拍子方式でもIRを保持する (後段の保存・アップロードに回せるようにする)
        let peak = 0;
        let peakIndex = 0;
        for (let i = 0; i < irData.length; i++) {
            if (Math.abs(irData[i]) > peak) {
                peak = Math.abs(irData[i]);
                peakIndex = i;
            }
        }
        const ir = {
            samples: irData,
            sampleRate: sampleRate,
            peakIndex: peakIndex,
            peakAmplitude: peak,
            decayEndIndex: irData.length,
            params: { signalType: 'impulse' }
        };

        return analyzeIR(irData, sampleRate, { method: 'impulse', ir });
    }

    /**
     * インパルス応答からRT60等を算出する (両測定方式で共通)
     * @param {Float32Array} irData - 直接音から始まるインパルス応答
     * @param {number} sampleRate
     * @param {object} meta - { method, ir }
     * @returns {Promise<object>}
     */
    function analyzeIR(irData, sampleRate, meta = {}) {
        const results = {
            sampleRate: sampleRate,
            duration: irData.length / sampleRate,
            bands: {},
            overall: null,
            timestamp: Date.now(),
            method: meta.method || 'impulse',
            // 算出したIRの実データ (保存・アップロード用に保持する。LocalStorageには保存しない)
            ir: meta.ir || null,
            signalParams: meta.ir ? meta.ir.params : null,
            plots: {
                irWave: AudioUtils.downsampleIRWaveform(irData, sampleRate),
                irDb: AudioUtils.buildIRDbCurve(irData, sampleRate)
            }
        };

        // 全帯域でのRT60計算
        const fullEDC = AudioUtils.schroederIntegration(irData);
        const fullResult = AudioUtils.calculateRT60(fullEDC, sampleRate, 'RT20');
        const fullEDCData = AudioUtils.downsampleEDC(fullEDC, sampleRate);

        results.overall = {
            rt60: fullResult.rt60,
            edt: fullResult.edt,
            r2: fullResult.regression ? fullResult.regression.r2 : 0,
            valid: fullResult.valid,
            edc: fullEDCData
        };

        // オクターブバンドごとの解析 (非同期)
        return processOctaveBands(irData, sampleRate, results);
    }

    /**
     * オクターブバンドごとの解析
     */
    async function processOctaveBands(irData, sampleRate, results) {
        const promises = AudioUtils.OCTAVE_BANDS.map(async (freq) => {
            try {
                const filteredData = await AudioUtils.applyBandpassFilter(irData, sampleRate, freq);
                const edc = AudioUtils.schroederIntegration(filteredData);
                const rt60Result = AudioUtils.calculateRT60(edc, sampleRate, 'RT20');
                const edcData = AudioUtils.downsampleEDC(edc, sampleRate);

                results.bands[freq] = {
                    rt60: rt60Result.rt60,
                    edt: rt60Result.edt,
                    r2: rt60Result.regression ? rt60Result.regression.r2 : 0,
                    valid: rt60Result.valid,
                    edc: edcData
                };
            } catch (err) {
                console.warn(`${freq}Hzバンドの処理に失敗:`, err);
                results.bands[freq] = {
                    rt60: NaN,
                    edt: NaN,
                    r2: 0,
                    valid: false,
                    edc: { times: [], values: [] }
                };
            }
        });

        await Promise.all(promises);
        return results;
    }

    /**
     * 測定を停止
     */
    function stopMeasurement() {
        isMeasuring = false;
        isRecording = false;
        if (scriptNode) {
            scriptNode.disconnect();
            scriptNode = null;
        }
        if (statusCallback) statusCallback('idle');
    }

    /**
     * 測定モードを設定
     */
    function setMode(mode) {
        measurementMode = mode;
    }

    /**
     * 測定モードを取得
     */
    function getMode() {
        return measurementMode;
    }

    /**
     * 測定中かどうか
     */
    function getIsMeasuring() {
        return isMeasuring;
    }

    /**
     * 直近に生成したピンクTSP (逆フィルタを含む) を取得
     */
    function getLastTsp() {
        return lastTsp;
    }

    /**
     * AudioContextを取得
     */
    function getAudioContext() {
        return audioCtx;
    }

    return {
        initMicrophone,
        stopMicrophone,
        startLevelMeter,
        setWaveformCallback,
        setStatusCallback,
        startImpulseMeasurement,
        startPinkTspMeasurement,
        getLastTsp,
        stopMeasurement,
        setMode,
        getMode,
        getIsMeasuring,
        getAudioContext
    };
})();
