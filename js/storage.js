/**
 * storage.js - データ管理 (LocalStorage)
 * 保存・読込・削除・エクスポート
 */

const Storage = (() => {
    const STORAGE_KEY = 'reverberation_measurements';

    /**
     * 全データを取得
     * LocalStorage は外から書き換えられるため、配列でなければ空とみなし、
     * オブジェクトでない要素 (null など。識別も表示もできない) は除く
     * @returns {Array} 保存済みデータの配列
     */
    function getAll() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            const parsed = data ? JSON.parse(data) : [];
            if (!Array.isArray(parsed)) {
                console.warn('保存データが配列ではないため読み込めません');
                return [];
            }
            return parsed.filter(isObject);
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
     * 保存データの結果を開ける形か (result と全帯域の結果 result.overall があるか)
     * 帯域別・EDC・数値の欠けは、表示や書き出しの側で N/A や非表示にする
     * @param {object} entry
     * @returns {boolean}
     */
    function isReadable(entry) {
        return isObject(entry) && isObject(entry.result) && isObject(entry.result.overall);
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
        const overall = entry.result.overall;
        const bands = isObject(entry.result.bands) ? entry.result.bands : {};

        // ヘッダー
        lines.push('# 残響測定結果');
        lines.push(`# 名前: ${entry.name}`);
        lines.push(`# 日時: ${formatDate(entry.date)}`);
        lines.push('');

        // 全体のRT60
        lines.push('# 全帯域');
        lines.push('パラメータ,値');
        lines.push(`RT60,${formatValue(overall.rt60)} s`);
        lines.push(`EDT,${formatValue(overall.edt)} s`);
        lines.push(`R²,${formatValue(overall.r2, 4)}`);
        lines.push('');

        // バンドごとのRT60
        lines.push('# 周波数帯別');
        lines.push('周波数(Hz),RT60(s),EDT(s),R²,有効');
        for (const [freq, band] of Object.entries(bands)) {
            if (!isObject(band)) continue;
            lines.push([
                freq,
                formatValue(band.rt60),
                formatValue(band.edt),
                formatValue(band.r2, 4),
                band.valid ? 'Yes' : 'No'
            ].join(','));
        }
        lines.push('');

        // EDCデータ
        const edc = overall.edc;
        if (isObject(edc) && Array.isArray(edc.times) && Array.isArray(edc.values)) {
            lines.push('# エネルギー減衰曲線 (EDC)');
            lines.push('時間(s),レベル(dB)');
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
            const overall = entry.result.overall;
            const bands = isObject(entry.result.bands) ? entry.result.bands : {};
            const row = [
                `"${entry.name}"`,
                formatDate(entry.date),
                formatValue(overall.rt60),
                formatValue(overall.edt)
            ];

            [125, 250, 500, 1000, 2000, 4000].forEach(freq => {
                const band = bands[freq];
                row.push(isObject(band) && band.valid ? formatValue(band.rt60) : 'N/A');
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
     * CSV は結果を開ける項目だけ。JSON は保存内容をそのまま書き出す (壊れた項目の中身を取り出せるように)
     * @returns {boolean} 書き出したか
     */
    function exportSingle(id, format) {
        const entry = getById(id);
        if (!entry || (format === 'csv' && !isReadable(entry))) return false;

        // 日時や名前が欠けた保存データでも、ファイル名を組み立てられるようにする
        const date = new Date(entry.date);
        const timestamp = (isNaN(date) ? new Date() : date).toISOString().slice(0, 10);
        const safeName = String(entry.name ?? '').replace(/[^a-zA-Z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g, '_') || 'measurement';

        if (format === 'csv') {
            downloadFile(toCSV(entry), `${safeName}_${timestamp}.csv`, 'text/csv;charset=utf-8');
        } else {
            downloadFile(toJSON(entry), `${safeName}_${timestamp}.json`, 'application/json');
        }
        return true;
    }

    /**
     * 複数データをエクスポート
     * CSV は結果を開けない項目を除く。JSON は保存内容をそのまま書き出す
     * @returns {number} 書き出した件数
     */
    function exportMultiple(ids, format) {
        const entries = ids.map(id => getById(id))
            .filter(entry => entry && (format !== 'csv' || isReadable(entry)));
        if (entries.length === 0) return 0;

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
        return entries.length;
    }

    // --- ユーティリティ ---

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    function formatDate(isoString) {
        const d = new Date(isoString);
        if (isNaN(d)) return '日時不明';
        return d.toLocaleString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatValue(v, digits = 3) {
        return Number.isFinite(v) ? v.toFixed(digits) : 'N/A';
    }

    function isObject(v) {
        return typeof v === 'object' && v !== null && !Array.isArray(v);
    }

    return {
        getAll,
        isReadable,
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
