/**
 * app.js - アプリケーションメインモジュール
 * 各モジュールの結合・イベント登録
 */

const App = (() => {
    let currentResult = null;
    let currentSavedId = null; // currentResult を保存した (または開いた) 保存データのID
    let micInitialized = false;

    /**
     * アプリケーション初期化
     */
    function init() {
        // テーマ初期化
        UI.initTheme();

        // 波形キャンバス初期化
        Visualization.initWaveform('waveformCanvas');

        // タブナビゲーション
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // 試聴の停止ボタンは測定タブにしか無いため、タブを移るときは止める
                Measurement.stopPreview();
                UI.switchTab(btn.dataset.tab);
            });
        });

        // テーマ切替ボタン
        document.getElementById('themeToggle')?.addEventListener('click', () => {
            UI.toggleTheme();
        });

        // ヘルプボタン
        document.getElementById('helpBtn')?.addEventListener('click', () => {
            UI.openHelp();
        });

        // ヘルプのステップ切替
        document.querySelectorAll('#helpModal .step-chip').forEach(chip => {
            chip.addEventListener('click', () => UI.showGuideStep(Number(chip.dataset.step)));
        });
        document.getElementById('guidePrev')?.addEventListener('click', UI.prevGuideStep);
        document.getElementById('guideNext')?.addEventListener('click', UI.nextGuideStep);

        // モーダルを閉じる
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const modal = btn.closest('.modal-overlay');
                if (modal) UI.closeModal(modal.id);
            });
        });

        // モーダルのオーバーレイクリックで閉じる
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) UI.closeModal(overlay.id);
            });
        });

        // 確認ダイアログ
        document.getElementById('confirmOk')?.addEventListener('click', () => UI.answerConfirm(true));
        document.getElementById('confirmCancel')?.addEventListener('click', () => UI.answerConfirm(false));
        document.addEventListener('keydown', UI.handleConfirmKeydown);

        // 未保存の測定結果はメモリにしか無いため、再読み込みや閉じる前に確認する
        // (この場面ではアプリ内のダイアログを出せず、ブラウザ標準の確認になる)
        window.addEventListener('beforeunload', (e) => {
            if (!hasUnsavedResult()) return;
            e.preventDefault();
            e.returnValue = '';
        });

        // 測定モード切替
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Measurement.stopPreview();
                Measurement.setMode(btn.dataset.mode);
                UI.setMeasureMode(btn.dataset.mode);

                // ピンクTSP設定の表示切替
                const tspSettings = document.getElementById('tspSettings');
                if (tspSettings) {
                    tspSettings.classList.toggle('visible', btn.dataset.mode === 'tsp');
                }
            });
        });

        // 測定前チェックリスト
        document.querySelectorAll('.pre-check').forEach(cb => {
            cb.addEventListener('change', UI.updatePreCheckCount);
        });
        UI.updatePreCheckCount();

        // 測定ボタン
        document.getElementById('measureBtn')?.addEventListener('click', startMeasurement);

        // 測定エラーの案内を閉じる
        document.querySelector('#measureAlert .measure-alert-close')?.addEventListener('click', UI.clearMeasureAlert);

        // ピンクTSP設定の変更で測定時間の目安を更新
        ['tspDuration', 'tspStartFreq', 'tspEndFreq', 'tspAverages'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', updateTspEstimate);
        });
        updateTspEstimate();

        // 測定音の試聴
        document.getElementById('tspPreviewBtn')?.addEventListener('click', togglePreview);

        // 再測定ボタン: 測定タブへ戻り、測定前チェックリストを開いて見直せるようにする
        document.getElementById('remeasureBtn')?.addEventListener('click', () => {
            const preCheck = document.getElementById('preCheck');
            if (preCheck) preCheck.open = true;
            UI.switchTab('measure');
            window.scrollTo(0, 0);
        });

        // 保存ボタン
        document.getElementById('saveBtn')?.addEventListener('click', saveResult);

        // 全選択チェックボックス
        document.getElementById('selectAll')?.addEventListener('change', (e) => {
            document.querySelectorAll('.data-checkbox').forEach(cb => {
                cb.checked = e.target.checked;
            });
        });

        // 選択削除ボタン
        document.getElementById('deleteSelectedBtn')?.addEventListener('click', deleteSelected);

        // エクスポートボタン
        document.getElementById('exportCsvBtn')?.addEventListener('click', () => exportSelected('csv'));
        document.getElementById('exportJsonBtn')?.addEventListener('click', () => exportSelected('json'));

        // ステータスコールバック設定
        Measurement.setStatusCallback((status) => {
            UI.updateMeasureStatus(status);
        });

        // 波形描画コールバック設定
        Measurement.setWaveformCallback((dataArray) => {
            Visualization.drawWaveform(dataArray);
        });

        // データ一覧更新
        UI.updateDataList();

        // 初回訪問時にヘルプを表示
        if (!localStorage.getItem('reverberation_visited')) {
            setTimeout(() => {
                UI.openHelp();
                localStorage.setItem('reverberation_visited', 'true');
            }, 500);
        }
    }

    /**
     * 測定を開始
     */
    async function startMeasurement() {
        if (Measurement.getIsMeasuring()) {
            Measurement.stopMeasurement();
            return;
        }

        if (hasUnsavedResult() && !await UI.confirm({
            title: '保存していない測定結果があります',
            message: '新しい測定が終わると、いまの測定結果は置き換わり、元に戻せません。残したい場合は「キャンセル」を押し、結果タブで保存してください。',
            okLabel: '保存せずに測定する'
        })) return;

        // 前回のエラー案内は、測定をやり直す時点で消す
        UI.clearMeasureAlert();

        // マイクの初期化
        if (!micInitialized) {
            UI.updateMeasureStatus('idle');
            const mic = await Measurement.initMicrophone();
            if (!mic.ok) {
                UI.showMicError(mic);
                return;
            }
            micInitialized = true;

            // レベルメーター開始
            Measurement.startLevelMeter((db, rms) => {
                updateLevelMeter(db, rms);
            });
        }

        // 試聴の音が録音に混ざらないよう、測定を始める直前に止める
        // (マイク許可の表示中に試聴が始められるため、マイク初期化の後で止める)
        Measurement.stopPreview();

        const mode = Measurement.getMode();
        let result = null;

        try {
            if (mode === 'tsp') {
                result = await Measurement.startPinkTspMeasurement(getTspOptions());
            } else {
                result = await Measurement.startImpulseMeasurement();
            }
        } catch (err) {
            console.error('測定エラー:', err);
            UI.showMeasureAlert({
                title: '測定に失敗しました',
                body: err.message || '測定に失敗しました。もう一度お試しください。'
            });
            return;
        }

        if (result) {
            currentResult = result;
            currentSavedId = null;
            UI.displayResults(result);

            if (result.ir && result.ir.clipped) {
                UI.showToast('入力がクリッピングしています。音量を下げて再測定してください', 'error');
            } else {
                UI.showToast('測定完了！', 'success');
            }

            // 結果タブに切り替え
            setTimeout(() => {
                UI.switchTab('results');
            }, 1000);
        } else {
            UI.showMeasureAlert({
                title: '測定に失敗しました',
                body: '音を検出できなかったか、解析に失敗しました。周囲を静かにして、もう一度「開始」を押してください。'
            });
        }
    }

    /**
     * 測定音の試聴を開始・停止する
     */
    function togglePreview() {
        if (Measurement.getIsPreviewing()) {
            Measurement.stopPreview();
            return;
        }
        try {
            const playing = Measurement.startPreview(getTspOptions(), () => UI.setPreviewPlaying(null));
            if (playing) UI.setPreviewPlaying(playing);
        } catch (err) {
            console.error('試聴エラー:', err);
            UI.showToast('測定音を再生できませんでした', 'error');
        }
    }

    /**
     * UIからピンクTSPの測定パラメータを読み取る
     */
    function getTspOptions() {
        const num = (id, fallback) => {
            const el = document.getElementById(id);
            const v = el ? parseFloat(el.value) : NaN;
            return isFinite(v) ? v : fallback;
        };

        const startFreq = num('tspStartFreq', PinkTSP.DEFAULTS.startFreq);
        let endFreq = num('tspEndFreq', PinkTSP.DEFAULTS.endFreq);

        // 開始 < 終了 を保証する (逆転入力への保険)
        if (endFreq <= startFreq * 2) {
            endFreq = startFreq * 2;
        }

        return {
            durationSec: num('tspDuration', PinkTSP.DEFAULTS.durationSec),
            startFreq: startFreq,
            endFreq: endFreq,
            averages: num('tspAverages', PinkTSP.DEFAULTS.averages)
        };
    }

    /**
     * ピンクTSPの測定時間の目安を表示する
     * 実際の信号長はAudioContextのサンプリングレートで決まるので、
     * マイク未初期化のうちは48kHz想定で概算する
     */
    function updateTspEstimate() {
        const el = document.getElementById('tspEstimate');
        const guideEl = document.getElementById('guideTspTime');
        if (!el) return;

        const opts = getTspOptions();
        const sampleRate = Measurement.getAudioContext()?.sampleRate || 48000;

        // 信号長は2の冪サンプルに丸められるため、丸めた後の長さで見積もる
        const signalSec = Math.pow(2, Math.round(Math.log2(sampleRate * opts.durationSec))) / sampleRate;
        const total = signalSec * (opts.averages + 2); // 再生は 同期加算回数+2 周期

        el.textContent = `約${total.toFixed(1)}秒 (信号長 ${signalSec.toFixed(2)}秒)`;
        if (guideEl) guideEl.textContent = `約${total.toFixed(1)}秒`;
    }

    /**
     * レベルメーターを更新
     */
    function updateLevelMeter(db, rms) {
        const levelValue = document.getElementById('levelValue');
        const levelFill = document.getElementById('levelFill');

        if (levelValue) {
            const displayDb = Math.max(-60, Math.min(0, Math.round(db)));
            levelValue.textContent = displayDb;
        }

        if (levelFill) {
            // -60dB〜0dBを0%〜100%にマップ (帯の色と位置をそろえるため、幅ではなく右側を隠して表す)
            const percent = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
            levelFill.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
        }
    }

    /**
     * 測定結果を保存
     */
    function saveResult() {
        if (!currentResult) {
            UI.showToast('保存する測定結果がありません', 'error');
            return;
        }

        const nameInput = document.getElementById('saveName');
        const name = nameInput ? nameInput.value.trim() : '';

        if (!name) {
            UI.showToast('測定名を入力してください', 'error');
            if (nameInput) nameInput.focus();
            return;
        }

        try {
            currentSavedId = Storage.save(name, currentResult);
            UI.showToast(`「${name}」を保存しました`, 'success');
            if (nameInput) nameInput.value = '';
            UI.updateDataList();
        } catch (e) {
            UI.showToast(e.message, 'error');
        }
    }

    /**
     * 保存済みの結果を表示
     */
    async function viewResult(id) {
        const entry = Storage.getById(id);
        if (!entry) return;

        if (hasUnsavedResult() && !await UI.confirm({
            title: '保存していない測定結果があります',
            message: '保存データを開くと、いまの測定結果は置き換わり、元に戻せません。残したい場合は「キャンセル」を押し、結果タブで保存してください。',
            okLabel: '保存せずに開く'
        })) return;

        currentResult = entry.result;
        currentSavedId = id;
        currentResult.overall = entry.result.overall;
        currentResult.bands = entry.result.bands;

        UI.displayResults(currentResult);
        UI.switchTab('results');
    }

    /**
     * 1件削除
     */
    async function deleteSingle(id) {
        if (!await UI.confirm({
            title: 'この測定データを削除しますか？',
            message: '削除したデータは元に戻せません。',
            okLabel: '削除する'
        })) return;

        const index = Storage.getAll().findIndex(item => item.id === id);
        Storage.deleteById(id);
        UI.updateDataList();

        // 押した削除ボタンは再描画で消えるため、同じ位置の行 (無ければ「すべて選択」) へフォーカスを移す
        const deleteButtons = document.querySelectorAll('#dataList .btn-icon-sm.delete');
        const next = deleteButtons[Math.min(index, deleteButtons.length - 1)] || document.getElementById('selectAll');
        next?.focus();

        UI.showToast('削除しました', 'success');
    }

    /**
     * 選択した項目を削除
     */
    async function deleteSelected() {
        const checked = document.querySelectorAll('.data-checkbox:checked');
        if (checked.length === 0) {
            UI.showToast('削除する項目を選択してください', 'error');
            return;
        }

        if (!await UI.confirm({
            title: `${checked.length}件のデータを削除しますか？`,
            message: '削除したデータは元に戻せません。',
            okLabel: '削除する'
        })) return;

        const ids = Array.from(checked).map(cb => cb.value);
        Storage.deleteByIds(ids);
        UI.updateDataList();

        // 全選択チェックを外す
        const selectAll = document.getElementById('selectAll');
        if (selectAll) selectAll.checked = false;

        UI.showToast(`${ids.length}件を削除しました`, 'success');
    }

    /**
     * 1件エクスポート
     */
    function exportSingle(id, format) {
        Storage.exportSingle(id, format);
        UI.showToast(`${format.toUpperCase()}ファイルをダウンロードしました`, 'success');
    }

    /**
     * 選択した項目をエクスポート
     */
    function exportSelected(format) {
        const checked = document.querySelectorAll('.data-checkbox:checked');
        if (checked.length === 0) {
            UI.showToast('エクスポートする項目を選択してください', 'error');
            return;
        }

        const ids = Array.from(checked).map(cb => cb.value);
        Storage.exportMultiple(ids, format);
        UI.showToast(`${ids.length}件を${format.toUpperCase()}でエクスポートしました`, 'success');
    }

    /**
     * 表示中の測定結果が保存されていないか
     * 保存後にその保存データを削除した場合も、結果はメモリにしか残らないので未保存とみなす
     */
    function hasUnsavedResult() {
        return !!currentResult && !(currentSavedId && Storage.getById(currentSavedId));
    }

    /**
     * 直近の測定で得られたインパルス応答を返す
     * (次フェーズのサーバアップロード用。UIや通信はまだ持たない)
     * @returns {object|null} { samples: Float32Array, sampleRate, peakIndex, ... }
     */
    function getCurrentIR() {
        return currentResult ? currentResult.ir || null : null;
    }

    /**
     * 直近の測定結果そのものを返す
     */
    function getCurrentResult() {
        return currentResult;
    }

    return {
        init,
        startMeasurement,
        getCurrentIR,
        getCurrentResult,
        saveResult,
        viewResult,
        deleteSingle,
        deleteSelected,
        exportSingle,
        exportSelected
    };
})();

// DOMContentLoaded で初期化
document.addEventListener('DOMContentLoaded', App.init);
