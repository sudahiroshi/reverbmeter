/**
 * ui.js - UI制御モジュール
 * テーマ切替、モーダル、トースト、タブ管理
 */

const UI = (() => {
    const THEME_KEY = 'reverberation_theme';

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
        toast.innerHTML = `<span>${icon}</span> ${message}`;

        container.appendChild(toast);

        // 3秒後に削除
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 3000);
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
            'idle': { text: '音源（手拍子・風船）を鳴らす準備ができたら開始', icon: '🎤', btnText: '開始', btnClass: '' },
            'waiting': { text: '💡 手拍子または風船を割ってください', icon: '👂', btnText: '待機中', btnClass: 'recording' },
            'recording': { text: '🔴 録音中...減衰を検出しています', icon: '⏺', btnText: '録音中', btnClass: 'recording' },
            'sweep-playing': { text: '🔊 スイープ信号を再生中...', icon: '📡', btnText: '再生中', btnClass: 'recording' },
            'sweep-recording': { text: '🎙️ 応答を録音中...', icon: '⏺', btnText: '録音中', btnClass: 'recording' },
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
            rt60El.innerHTML = !isNaN(overall.rt60)
                ? `${overall.rt60.toFixed(3)}<span class="unit">秒</span>`
                : `N/A`;
        }

        if (edtEl) {
            edtEl.innerHTML = !isNaN(overall.edt)
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
                const rt60 = item.result && item.result.overall && !isNaN(item.result.overall.rt60)
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
        showModal,
        closeModal,
        showToast,
        confirm,
        updateMeasureStatus,
        displayResults,
        updateDataList
    };
})();
