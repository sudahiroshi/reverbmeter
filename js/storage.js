/**
 * storage.js - データ管理 (LocalStorage)
 * 保存・読込・削除・エクスポート
 */

const Storage = (() => {
    const STORAGE_KEY = 'reverberation_measurements';

    /**
     * 全データを取得
     * @returns {Array} 保存済みデータの配列
     */
    function getAll() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            console.error('データの読み込みに失敗:', e);
            return [];
        }
    }

    /**
     * データを保存
     * @param {string} name - 測定名
     * @param {object} measurementResult - 測定結果
     * @returns {string} 保存されたデータのID
     */
    /**
     * NaN/Infinityを null に変換してJSON安全にする
     */
    function sanitizeForStorage(obj) {
        return JSON.parse(JSON.stringify(obj, (key, value) => {
            if (typeof value === 'number' && (isNaN(value) || !isFinite(value))) {
                return null;
            }
            return value;
        }));
    }

    function save(name, measurementResult) {
        const data = getAll();
        const id = generateId();

        // 結果をサニタイズ（NaN → null）
        const sanitizedResult = sanitizeForStorage({
            sampleRate: measurementResult.sampleRate,
            duration: measurementResult.duration,
            overall: measurementResult.overall,
            bands: measurementResult.bands,
            timestamp: measurementResult.timestamp
        });

        const entry = {
            id: id,
            name: name || `測定 ${data.length + 1}`,
            date: new Date().toISOString(),
            result: sanitizedResult
        };

        data.unshift(entry); // 新しいデータを先頭に

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            return id;
        } catch (e) {
            console.error('データの保存に失敗:', e);
            // ストレージ容量不足の場合
            if (e.name === 'QuotaExceededError') {
                throw new Error('ストレージの容量が不足しています。不要なデータを削除してください。');
            }
            throw e;
        }
    }

    /**
     * IDでデータを取得
     * @param {string} id
     * @returns {object|null}
     */
    function getById(id) {
        const data = getAll();
        return data.find(d => d.id === id) || null;
    }

    /**
     * 1件削除
     * @param {string} id
     */
    function deleteById(id) {
        const data = getAll();
        const filtered = data.filter(d => d.id !== id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    }

    /**
     * 複数削除
     * @param {string[]} ids
     */
    function deleteByIds(ids) {
        const data = getAll();
        const filtered = data.filter(d => !ids.includes(d.id));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    }

    /**
     * 全件削除
     */
    function deleteAll() {
        localStorage.removeItem(STORAGE_KEY);
    }

    /**
     * データをCSVに変換
     * @param {object} entry
     * @returns {string}
     */
    function toCSV(entry) {
        const lines = [];

        // ヘッダー
        lines.push('# 残響測定結果');
        lines.push(`# 名前: ${entry.name}`);
        lines.push(`# 日時: ${formatDate(entry.date)}`);
        lines.push('');

        // 全体のRT60
        lines.push('# 全帯域');
        lines.push('パラメータ,値');
        if (entry.result.overall) {
            lines.push(`RT60,${formatValue(entry.result.overall.rt60)} s`);
            lines.push(`EDT,${formatValue(entry.result.overall.edt)} s`);
            lines.push(`R²,${entry.result.overall.r2 ? entry.result.overall.r2.toFixed(4) : 'N/A'}`);
        }
        lines.push('');

        // バンドごとのRT60
        lines.push('# 周波数帯別');
        lines.push('周波数(Hz),RT60(s),EDT(s),R²,有効');
        if (entry.result.bands) {
            for (const [freq, band] of Object.entries(entry.result.bands)) {
                lines.push([
                    freq,
                    formatValue(band.rt60),
                    formatValue(band.edt),
                    band.r2 ? band.r2.toFixed(4) : 'N/A',
                    band.valid ? 'Yes' : 'No'
                ].join(','));
            }
        }
        lines.push('');

        // EDCデータ
        if (entry.result.overall && entry.result.overall.edc) {
            lines.push('# エネルギー減衰曲線 (EDC)');
            lines.push('時間(s),レベル(dB)');
            const edc = entry.result.overall.edc;
            for (let i = 0; i < edc.times.length; i++) {
                lines.push(`${edc.times[i]},${edc.values[i]}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * データをJSONに変換
     * @param {object} entry
     * @returns {string}
     */
    function toJSON(entry) {
        const exportData = {
            name: entry.name,
            date: entry.date,
            result: entry.result
        };
        return JSON.stringify(exportData, null, 2);
    }

    /**
     * 複数データをCSVに変換
     * @param {object[]} entries
     * @returns {string}
     */
    function multiToCSV(entries) {
        const lines = [];
        lines.push('名前,日時,RT60全帯域(s),EDT全帯域(s),125Hz,250Hz,500Hz,1kHz,2kHz,4kHz');

        entries.forEach(entry => {
            const row = [
                `"${entry.name}"`,
                formatDate(entry.date),
                entry.result.overall ? formatValue(entry.result.overall.rt60) : 'N/A',
                entry.result.overall ? formatValue(entry.result.overall.edt) : 'N/A'
            ];

            [125, 250, 500, 1000, 2000, 4000].forEach(freq => {
                const band = entry.result.bands ? entry.result.bands[freq] : null;
                row.push(band && band.valid ? formatValue(band.rt60) : 'N/A');
            });

            lines.push(row.join(','));
        });

        return lines.join('\n');
    }

    /**
     * ファイルとしてダウンロード
     * @param {string} content
     * @param {string} filename
     * @param {string} type
     */
    function downloadFile(content, filename, type) {
        const blob = new Blob([content], { type: type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * 1件のデータをエクスポート
     */
    function exportSingle(id, format) {
        const entry = getById(id);
        if (!entry) return;

        const timestamp = new Date(entry.date).toISOString().slice(0, 10);
        const safeName = entry.name.replace(/[^a-zA-Z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_');

        if (format === 'csv') {
            downloadFile(toCSV(entry), `${safeName}_${timestamp}.csv`, 'text/csv;charset=utf-8');
        } else {
            downloadFile(toJSON(entry), `${safeName}_${timestamp}.json`, 'application/json');
        }
    }

    /**
     * 複数データをエクスポート
     */
    function exportMultiple(ids, format) {
        const entries = ids.map(id => getById(id)).filter(Boolean);
        if (entries.length === 0) return;

        const timestamp = new Date().toISOString().slice(0, 10);

        if (format === 'csv') {
            downloadFile(multiToCSV(entries), `measurements_${timestamp}.csv`, 'text/csv;charset=utf-8');
        } else {
            const exported = entries.map(e => ({
                name: e.name,
                date: e.date,
                result: e.result
            }));
            downloadFile(JSON.stringify(exported, null, 2), `measurements_${timestamp}.json`, 'application/json');
        }
    }

    // --- ユーティリティ ---

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    function formatDate(isoString) {
        const d = new Date(isoString);
        return d.toLocaleString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatValue(v) {
        if (v === null || v === undefined || isNaN(v)) return 'N/A';
        return v.toFixed(3);
    }

    return {
        getAll,
        save,
        getById,
        deleteById,
        deleteByIds,
        deleteAll,
        exportSingle,
        exportMultiple,
        formatDate
    };
})();
