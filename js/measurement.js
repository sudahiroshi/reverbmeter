/**
 * measurement.js - 測定エンジン
 * マイク入力、インパルス応答録音、スイープ信号測定
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
    let measurementMode = 'impulse'; // 'impulse' or 'sweep'
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
            return true;
        } catch (err) {
            console.error('マイクの初期化に失敗:', err);
            return false;
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
            const success = await initMicrophone();
            if (!success) return null;
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
                const inputData = e.inputBuffer.getChannelData(0);
                const output = e.outputBuffer.getChannelData(0);
                output.set(inputData);

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
     * スイープ信号方式の測定を開始
     */
    async function startSweepMeasurement(sweepDuration = 3) {
        if (!audioCtx || !sourceNode) {
            const success = await initMicrophone();
            if (!success) return null;
        }

        // AudioContextが suspended の場合は resume
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        if (statusCallback) statusCallback('sweep-playing');

        return new Promise((resolve) => {
            const sampleRate = audioCtx.sampleRate;

            // スイープ信号を生成・再生
            const sweepSignal = AudioUtils.generateLogSweep(sampleRate, sweepDuration);
            const sweepBuffer = audioCtx.createBuffer(1, sweepSignal.length, sampleRate);
            sweepBuffer.getChannelData(0).set(sweepSignal);

            const sweepSource = audioCtx.createBufferSource();
            sweepSource.buffer = sweepBuffer;

            // ゲインを少し下げて再生
            const gainNode = audioCtx.createGain();
            gainNode.gain.value = 0.5;
            sweepSource.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            // 同時に録音開始
            recordedSamples = [];
            isMeasuring = true;
            isRecording = true;

            const bufferSize = 4096;
            scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);

            scriptNode.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const output = e.outputBuffer.getChannelData(0);
                output.set(inputData);

                if (isRecording) {
                    for (let i = 0; i < inputData.length; i++) {
                        recordedSamples.push(inputData[i]);
                    }
                }
            };

            sourceNode.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);

            sweepSource.start(0);

            if (statusCallback) statusCallback('sweep-recording');

            // スイープ再生後の余韻も録音
            sweepSource.onended = () => {
                setTimeout(() => {
                    isRecording = false;
                    isMeasuring = false;

                    if (scriptNode) {
                        scriptNode.disconnect();
                        scriptNode = null;
                    }

                    if (statusCallback) statusCallback('processing');

                    const recorded = new Float32Array(recordedSamples);

                    // 簡易的なデコンボリューション (相互相関で近似)
                    setTimeout(() => {
                        const result = analyzeWithSweep(recorded, sweepSignal, sampleRate);
                        if (statusCallback) statusCallback('done');
                        resolve(result);
                    }, 100);
                }, 2000); // 2秒の余韻
            };
        });
    }

    /**
     * インパルス応答を解析
     */
    function analyzeImpulseResponse(rawData, sampleRate) {
        if (!rawData || rawData.length === 0) return null;

        // インパルス開始点を検出
        const startIdx = AudioUtils.detectImpulseStart(rawData);
        const irData = rawData.slice(startIdx);

        const results = {
            sampleRate: sampleRate,
            duration: irData.length / sampleRate,
            bands: {},
            overall: null,
            timestamp: Date.now()
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
     * スイープ信号測定の解析 (簡易デコンボリューション)
     */
    async function analyzeWithSweep(recorded, sweep, sampleRate) {
        // 簡易的：逆スイープとの畳み込み (時間領域)
        // 本格的にはFFTを使うべきだが、ブラウザ環境では計算量を考慮
        const inverseSweep = AudioUtils.generateInverseSweep(sweep, sampleRate);

        // OfflineAudioContextで畳み込みを実行
        try {
            const convLen = recorded.length + inverseSweep.length - 1;
            const ctx = new OfflineAudioContext(1, convLen, sampleRate);

            // 録音データを入力
            const recBuffer = ctx.createBuffer(1, recorded.length, sampleRate);
            recBuffer.getChannelData(0).set(recorded);
            const recSource = ctx.createBufferSource();
            recSource.buffer = recBuffer;

            // コンボルバーに逆スイープをセット
            const convBuffer = ctx.createBuffer(1, inverseSweep.length, sampleRate);
            convBuffer.getChannelData(0).set(inverseSweep);
            const convolver = ctx.createConvolver();
            convolver.buffer = convBuffer;

            recSource.connect(convolver);
            convolver.connect(ctx.destination);
            recSource.start(0);

            const renderedBuffer = await ctx.startRendering();
            const irData = renderedBuffer.getChannelData(0);

            // 得られたインパルス応答を解析
            const results = {
                sampleRate: sampleRate,
                duration: irData.length / sampleRate,
                bands: {},
                overall: null,
                timestamp: Date.now()
            };

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

            return processOctaveBands(irData, sampleRate, results);
        } catch (err) {
            console.error('スイープ解析エラー:', err);
            return null;
        }
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
        startSweepMeasurement,
        stopMeasurement,
        setMode,
        getMode,
        getIsMeasuring,
        getAudioContext
    };
})();
