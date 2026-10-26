/**
 * ui.js - UI制御モジュール
 * テーマ切替、モーダル、トースト、タブ管理
 */

const UI = (() => {
    const THEME_KEY = 'reverberation_theme';
    let guideStep = 0; // ヘルプで表示中のステップ

    /**
     * テーマを初期化
     */
    function initTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved) {
            setTheme(saved);
        } else {
            // システム設定を確認
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            setTheme(prefersDark ? 'dark' : 'light');
        }

        // システム設定の変更を監視
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!localStorage.getItem(THEME_KEY)) {
                setTheme(e.matches ? 'dark' : 'light');
            }
        });
    }

    /**
     * テーマを設定
     */
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(THEME_KEY, theme);

        // アイコンを更新
        const toggleBtn = document.getElementById('themeToggle');
        if (toggleBtn) {
            toggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
        }

        // Chart.jsのテーマ更新
        if (typeof Visualization !== 'undefined') {
            Visualization.updateTheme();
        }
    }

    /**
     * テーマをトグル
     */
    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        setTheme(current === 'dark' ? 'light' : 'dark');
    }

    /**
     * タブ切り替え
     */
    function switchTab(tabId) {
        // タブボタンの更新
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // パネルの更新
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === tabId);
        });
    }

    /**
     * 測定タブの案内を測定モードに合わせる (data-only の項目の表示は CSS で切り替える)
     */
    function setMeasureMode(mode) {
        const panel = document.getElementById('measure');
        if (panel) panel.dataset.mode = mode;
        updatePreCheckCount();
    }

    /**
     * 測定前チェックリストの確認済み件数を更新する (表示中のモードの項目だけ数える)
     */
    function updatePreCheckCount() {
        const panel = document.getElementById('measure');
        const countEl = document.getElementById('preCheckCount');
        if (!panel || !countEl) return;

        const mode = panel.dataset.mode;
        const items = Array.from(panel.querySelectorAll('.check-list li'))
            .filter(li => !li.dataset.only || li.dataset.only === mode);
        const checked = items.filter(li => li.querySelector('.pre-check').checked).length;
        const done = checked === items.length;

        countEl.textContent = `${done ? '✓ ' : ''}${checked} / ${items.length} 確認済み`;
        countEl.classList.toggle('done', done);
    }

    /**
     * モーダルを表示
     */
    function showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';
        }
    }

    /**
     * モーダルを閉じる
     */
    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
            document.body.style.overflow = '';
        }
    }

    /**
     * トースト通知を表示
     */
    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
        toast.innerHTML = `<span>${icon}</span> ${escapeHtml(String(message))}`;

        container.appendChild(toast);

        // 3秒後に削除
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 3000);
    }

    /**
     * マイク初期化失敗の原因別の案内 (Measurement.initMicrophone の reason に対応)
     */
    const MIC_ERROR_GUIDES = {
        'insecure': {
            title: '安全な接続（HTTPS）で開かれていません',
            body: 'ブラウザは https:// で始まるページでしかマイクを使えません。https:// のURLで開き直してください（PCで動作を試す場合は http://localhost でも使えます）。'
        },
        'denied': {
            title: 'マイクの使用が許可されていません',
            body: 'ブラウザのサイト設定でこのページのマイクを「許可」に変更し、ページを再読み込みしてから、もう一度「開始」を押してください。',
            showPermissionHelp: true
        },
        'not-found': {
            title: 'マイクが見つかりません',
            body: 'マイクが接続されているか、OSのサウンド設定で入力デバイスが有効になっているかを確認し、もう一度「開始」を押してください。'
        },
        'other': {
            title: 'マイクを開始できませんでした',
            body: '通話・録音アプリなど、ほかのアプリがマイクを使っていないか確認してください。ページを再読み込みしてから、もう一度「開始」を押してください。',
            showPermissionHelp: true
        }
    };

    /**
     * マイク初期化の失敗を原因別に案内する
     * @param {{reason: string, errorName?: string}} mic - Measurement.initMicrophone の戻り値
     */
    function showMicError(mic) {
        const guide = MIC_ERROR_GUIDES[mic.reason] || MIC_ERROR_GUIDES['other'];
        showMeasureAlert({
            title: guide.title,
            body: guide.body,
            detail: mic.errorName ? `エラー: ${mic.errorName}` : '',
            action: guide.showPermissionHelp
                ? { label: '端末別のマイク許可手順を見る', onClick: () => openHelp('helpMicPermission') }
                : null
        });
    }

    /**
     * 測定カード内にエラー案内を表示する (トーストと違い、閉じるか次の測定まで残る)
     * @param {{title: string, body: string, detail?: string, action?: {label: string, onClick: Function}}} alert
     */
    function showMeasureAlert({ title, body, detail = '', action = null }) {
        const el = document.getElementById('measureAlert');
        if (!el) return;

        el.querySelector('.measure-alert-title').textContent = title;
        el.querySelector('.measure-alert-body').textContent = body;

        const detailEl = el.querySelector('.measure-alert-detail');
        detailEl.textContent = detail;
        detailEl.hidden = !detail;

        const actionBtn = el.querySelector('.measure-alert-action');
        actionBtn.hidden = !action;
        actionBtn.onclick = action ? action.onClick : null;
        if (action) actionBtn.textContent = action.label;

        el.hidden = false;
        el.scrollIntoView({ block: 'nearest' });
    }

    /**
     * 測定カード内のエラー案内を消す
     */
    function clearMeasureAlert() {
        const el = document.getElementById('measureAlert');
        if (el) el.hidden = true;
    }

    /**
     * ヘルプを開く。anchorId を指定すると、その見出しを含むステップを開いてスクロールする
     */
    function openHelp(anchorId) {
        const anchor = anchorId ? document.getElementById(anchorId) : null;
        const step = anchor?.closest('.guide-step');
        showModal('helpModal');
        showGuideStep(step ? Number(step.dataset.step) : 0);
        if (anchor) anchor.scrollIntoView({ block: 'start' });
    }

    /**
     * ヘルプの指定ステップ (0:概要 1:準備 2:測定 3:結果) を表示する
     */
    function showGuideStep(index) {
        const modal = document.getElementById('helpModal');
        if (!modal) return;

        const steps = modal.querySelectorAll('.guide-step');
        guideStep = Math.max(0, Math.min(steps.length - 1, index));
        const isLast = guideStep === steps.length - 1;

        steps.forEach((section, i) => { section.hidden = i !== guideStep; });
        modal.querySelectorAll('.step-chip').forEach((chip, i) => {
            chip.classList.toggle('active', i === guideStep);
            if (i === guideStep) {
                chip.setAttribute('aria-current', 'step');
            } else {
                chip.removeAttribute('aria-current');
            }
        });

        document.getElementById('guidePrev').disabled = guideStep === 0;
        document.getElementById('guideNext').textContent = isLast ? 'はじめる' : '次へ →';
        document.getElementById('guideStepCount').textContent = `${guideStep + 1} / ${steps.length}`;
        modal.querySelector('.modal-body').scrollTop = 0;
    }

    /**
     * ヘルプの次のステップへ進む (最後のステップでは閉じる)
     */
    function nextGuideStep() {
        const total = document.querySelectorAll('#helpModal .guide-step').length;
        if (guideStep >= total - 1) {
            closeModal('helpModal');
        } else {
            showGuideStep(guideStep + 1);
        }
    }

    /**
     * ヘルプの前のステップへ戻る
     */
    function prevGuideStep() {
        showGuideStep(guideStep - 1);
    }

    /**
     * 確認ダイアログ
     */
    function confirm(message) {
        return window.confirm(message);
    }

    /**
     * 測定ステータスを更新
     */
    function updateMeasureStatus(status) {
        const statusEl = document.getElementById('measureStatus');
        const measureBtn = document.getElementById('measureBtn');
        const btnIcon = measureBtn?.querySelector('.btn-icon');
        const btnText = measureBtn?.querySelector('.btn-text');

        const statusMap = {
            'idle': { text: '準備ができたら「開始」を押してください', icon: '🎤', btnText: '開始', btnClass: '' },
            'waiting': { text: '💡 手拍子または風船を割ってください', icon: '👂', btnText: '待機中', btnClass: 'recording' },
            'recording': { text: '🔴 録音中...減衰を検出しています', icon: '⏺', btnText: '録音中', btnClass: 'recording' },
            'tsp-playing': { text: '🔊 ピンクTSPを再生中... 静かにしてください', icon: '📡', btnText: '測定中', btnClass: 'recording' },
            'processing': { text: '⚙️ 解析中...', icon: '⏳', btnText: '解析中', btnClass: 'processing' },
            'done': { text: '✅ 測定完了！結果タブで確認できます', icon: '🎤', btnText: '開始', btnClass: '' }
        };

        const s = statusMap[status] || statusMap['idle'];

        if (statusEl) statusEl.textContent = s.text;
        if (btnIcon) btnIcon.textContent = s.icon;
        if (btnText) btnText.textContent = s.btnText;

        if (measureBtn) {
            measureBtn.classList.remove('recording', 'processing');
            if (s.btnClass) measureBtn.classList.add(s.btnClass);
        }
    }

    /**
     * 結果パネルにRT60データを表示
     */
    function displayResults(result) {
        if (!result || !result.overall) return;

        const overall = result.overall;

        // RT60値を表示
        const rt60El = document.getElementById('rt60Value');
        const edtEl = document.getElementById('edtValue');
        const r2El = document.getElementById('r2Value');
        const validEl = document.getElementById('validValue');

        if (rt60El) {
            rt60El.innerHTML = Number.isFinite(overall.rt60)
                ? `${overall.rt60.toFixed(3)}<span class="unit">秒</span>`
                : `N/A`;
        }

        if (edtEl) {
            edtEl.innerHTML = Number.isFinite(overall.edt)
                ? `${overall.edt.toFixed(3)}<span class="unit">秒</span>`
                : `N/A`;
        }

        if (r2El) {
            const r2 = overall.r2 || 0;
            r2El.innerHTML = `${(r2 * 100).toFixed(1)}<span class="unit">%</span>`;
        }

        if (validEl) {
            validEl.innerHTML = overall.valid
                ? `<span style="color:var(--success)">✓ 有効</span>`
                : `<span style="color:var(--warning)">△ 不確実</span>`;
        }

        displayValidityAdvice(result);

        // インパルス応答グラフ (保存済みデータには含まれないため存在する場合のみ)
        const irCard = document.getElementById('irChart')?.closest('.card');
        if (result.plots && result.plots.irWave && result.plots.irWave.times.length > 0) {
            if (irCard) irCard.style.display = '';
            Visualization.drawIRChart('irChart', result.plots.irWave);
            Visualization.drawIRDbChart('irDbChart', result.plots.irDb);
            displayIRInfo(result);
        } else if (irCard) {
            irCard.style.display = 'none';
        }

        // EDCグラフ
        if (overall.edc && overall.edc.times.length > 0) {
            Visualization.drawEDCChart('edcChart', overall.edc);
        }

        // バンドグラフ
        if (result.bands && Object.keys(result.bands).length > 0) {
            Visualization.drawBandChart('bandChart', result.bands);
        }

        // 結果プレースホルダーを非表示
        const placeholder = document.getElementById('resultPlaceholder');
        const resultContent = document.getElementById('resultContent');
        if (placeholder) placeholder.style.display = 'none';
        if (resultContent) resultContent.style.display = 'block';
    }

    /**
     * 「△ 不確実」またはクリッピングのとき、理由と改善方法を表示する
     */
    function displayValidityAdvice(result) {
        const el = document.getElementById('validityAdvice');
        if (!el) return;

        const overall = result.overall;
        const ir = result.ir;
        const clipped = !!(ir && ir.clipped);
        if (overall.valid && !clipped) {
            el.hidden = true;
            return;
        }

        // 理由は有効判定 (AudioUtils.calculateRT60) と同じ条件で挙げる
        const r2 = overall.r2 || 0;
        const reasons = [];
        if (!Number.isFinite(overall.rt60) || overall.rt60 <= 0) {
            reasons.push('減衰が十分に録音できず、RT60 を算出できませんでした。');
        }
        if (r2 <= 0.8) {
            reasons.push(`適合度 R² が ${(r2 * 100).toFixed(1)}% で、有効の基準（80% を超えること）に届いていません。` +
                '減衰曲線がまっすぐ下がっておらず、騒音や音の小ささの影響が考えられます。');
        }
        if (clipped) {
            reasons.push(`入力がクリッピングしています（${(ir.clippingRatio * 100).toFixed(1)}%）。音が大きすぎて波形がひずんでいます。`);
        }

        const tips = ['窓とドアを閉め、エアコンや換気扇を止めて、静かな状態で測定する'];
        if (result.method === 'impulse') {
            tips.push('手拍子はマイクから1〜2m離れて、1回だけはっきり鳴らす（小さすぎると減衰を捉えられません）');
        } else if (result.method === 'pink-tsp') {
            tips.push(clipped
                ? '端末の音量を下げる'
                : '端末の音量を上げる。改善しない場合は、同期加算回数を増やすか信号長を長くする');
            tips.push('スピーカーとマイクを手や物でふさがない');
        }
        tips.push('同じ場所で2〜3回測定し、値がそろうか確かめる');

        el.querySelector('.result-advice-title').textContent = overall.valid
            ? '⚠️ 注意が必要な結果です'
            : '△ この結果は不確実です';
        fillList(el.querySelector('.result-advice-reasons'), reasons);
        fillList(el.querySelector('.result-advice-tips'), tips);
        el.hidden = false;
    }

    /**
     * 文字列の配列を <li> として ul に入れる
     */
    function fillList(ul, items) {
        ul.replaceChildren(...items.map(text => {
            const li = document.createElement('li');
            li.textContent = text;
            return li;
        }));
    }

    /**
     * IRの測定条件を表示
     */
    function displayIRInfo(result) {
        const el = document.getElementById('irInfo');
        if (!el) return;

        const ir = result.ir;
        const items = [];

        if (result.method === 'pink-tsp' && ir && ir.params) {
            const p = ir.params;
            items.push(['測定信号', 'ピンクTSP (-3dB/oct)']);
            items.push(['周波数範囲', `${Math.round(p.startFreq)} Hz 〜 ${Math.round(p.endFreq)} Hz`]);
            items.push(['信号長', `${p.durationSec.toFixed(2)} 秒`]);
            items.push(['同期加算', `${ir.blocksUsed} 回`]);
            items.push(['入力レベル', `${ir.inputLevelDbfs.toFixed(1)} dBFS`]);
            items.push(['S/N (推定)', `${ir.snrDb.toFixed(1)} dB`]);
            if (ir.clipped) {
                items.push(['⚠️ 警告', `クリッピング検出 (${(ir.clippingRatio * 100).toFixed(1)}%)`]);
            }
        } else {
            items.push(['測定信号', 'インパルス応答 (手拍子・風船)']);
        }

        items.push(['サンプリング周波数', `${result.sampleRate} Hz`]);
        items.push(['IR長', `${result.duration.toFixed(2)} 秒`]);

        el.innerHTML = items.map(([label, value]) => `
            <div class="setting-row">
              <span class="setting-label">${label}</span>
              <span class="setting-value">${escapeHtml(String(value))}</span>
            </div>`).join('');
    }

    /**
     * データ一覧を更新
     */
    function updateDataList() {
        const listEl = document.getElementById('dataList');
        const emptyEl = document.getElementById('dataEmpty');
        const countEl = document.getElementById('dataCount');
        if (!listEl) return;

        const data = Storage.getAll();

        if (countEl) countEl.textContent = `${data.length}件`;

        if (data.length === 0) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        listEl.innerHTML = data.map(item => {
            try {
                const rt60 = item.result && item.result.overall && Number.isFinite(item.result.overall.rt60)
                    ? item.result.overall.rt60.toFixed(3) + 's'
                    : 'N/A';

                return `
            <li class="data-item" data-id="${item.id}">
              <input type="checkbox" class="data-checkbox" value="${item.id}" aria-label="選択">
              <div class="data-item-info" onclick="App.viewResult('${item.id}')">
                <div class="data-item-name">${escapeHtml(item.name || '名前なし')}</div>
                <div class="data-item-meta">
                  <span>${Storage.formatDate(item.date)}</span>
                  <span>RT60: ${rt60}</span>
                </div>
              </div>
              <div class="data-item-actions">
                <button class="btn-icon-sm" onclick="App.exportSingle('${item.id}', 'csv')" title="CSV出力">📄</button>
                <button class="btn-icon-sm" onclick="App.exportSingle('${item.id}', 'json')" title="JSON出力">📋</button>
                <button class="btn-icon-sm delete" onclick="App.deleteSingle('${item.id}')" title="削除">🗑️</button>
              </div>
            </li>
          `;
            } catch (err) {
                console.warn('データ項目の描画エラー:', item, err);
                return `
            <li class="data-item" data-id="${item.id || 'unknown'}">
              <input type="checkbox" class="data-checkbox" value="${item.id || ''}" aria-label="選択">
              <div class="data-item-info">
                <div class="data-item-name">⚠️ 破損データ</div>
                <div class="data-item-meta"><span>読み込めません</span></div>
              </div>
              <div class="data-item-actions">
                <button class="btn-icon-sm delete" onclick="App.deleteSingle('${item.id || ''}')" title="削除">🗑️</button>
              </div>
            </li>
          `;
            }
        }).join('');
    }

    /**
     * HTMLエスケープ
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    return {
        initTheme,
        toggleTheme,
        switchTab,
        setMeasureMode,
        updatePreCheckCount,
        showModal,
        closeModal,
        showToast,
        showMicError,
        showMeasureAlert,
        clearMeasureAlert,
        openHelp,
        showGuideStep,
        nextGuideStep,
        prevGuideStep,
        confirm,
        updateMeasureStatus,
        displayResults,
        updateDataList
    };
})();
