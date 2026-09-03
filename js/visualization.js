/**
 * visualization.js - グラフ・波形・メーター の描画
 */

const Visualization = (() => {
    let edcChart = null;
    let bandChart = null;
    let irChart = null;
    let irDbChart = null;
    let waveformCtx = null;
    let waveformCanvas = null;

    // Chart.js テーマカラー
    const COLORS = {
        light: {
            grid: 'rgba(0, 0, 0, 0.06)',
            text: '#5a6270',
            accent: '#4f6ef7',
            edcLine: '#4f6ef7',
            edcFill: 'rgba(79, 110, 247, 0.1)',
            regression: '#ef4565',
            bands: ['#4f6ef7', '#6c8aff', '#2cb67d', '#f5a623', '#ef4565', '#a855f7'],
            waveform: '#4f6ef7',
            waveformBg: '#e8ecf1',
            ir: '#2cb67d',
            irFill: 'rgba(44, 182, 125, 0.12)',
            schroeder: '#ef4565'
        },
        dark: {
            grid: 'rgba(255, 255, 255, 0.06)',
            text: '#9ba3b0',
            accent: '#6c8aff',
            edcLine: '#6c8aff',
            edcFill: 'rgba(108, 138, 255, 0.12)',
            regression: '#ff6b8a',
            bands: ['#6c8aff', '#8da3ff', '#3dd68c', '#ffbe4f', '#ff6b8a', '#c084fc'],
            waveform: '#6c8aff',
            waveformBg: '#252830',
            ir: '#3dd68c',
            irFill: 'rgba(61, 214, 140, 0.15)',
            schroeder: '#ff6b8a'
        }
    };

    function getThemeColors() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return isDark ? COLORS.dark : COLORS.light;
    }

    /**
     * 波形キャンバスを初期化
     */
    function initWaveform(canvasId) {
        waveformCanvas = document.getElementById(canvasId);
        if (!waveformCanvas) return;
        waveformCtx = waveformCanvas.getContext('2d');
        resizeWaveformCanvas();
        window.addEventListener('resize', resizeWaveformCanvas);
    }

    function resizeWaveformCanvas() {
        if (!waveformCanvas) return;
        const rect = waveformCanvas.getBoundingClientRect();
        waveformCanvas.width = rect.width * window.devicePixelRatio;
        waveformCanvas.height = rect.height * window.devicePixelRatio;
        waveformCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    }

    /**
     * 波形を描画
     */
    function drawWaveform(dataArray) {
        if (!waveformCtx || !waveformCanvas) return;

        const colors = getThemeColors();
        const width = waveformCanvas.clientWidth;
        const height = waveformCanvas.clientHeight;
        const ctx = waveformCtx;

        ctx.clearRect(0, 0, width, height);

        // 背景
        ctx.fillStyle = colors.waveformBg;
        ctx.fillRect(0, 0, width, height);

        // 中心線
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // 波形
        ctx.strokeStyle = colors.waveform;
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        const sliceWidth = width / dataArray.length;
        let x = 0;

        for (let i = 0; i < dataArray.length; i++) {
            const v = dataArray[i];
            const y = (1 - v) * height / 2;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
            x += sliceWidth;
        }

        ctx.stroke();
    }

    /**
     * EDCグラフを描画
     */
    function drawEDCChart(canvasId, edcData, regressionLine = null, title = '') {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const colors = getThemeColors();

        if (edcChart) {
            edcChart.destroy();
        }

        const datasets = [{
            label: 'EDC (エネルギー減衰曲線)',
            data: edcData.values,
            borderColor: colors.edcLine,
            backgroundColor: colors.edcFill,
            borderWidth: 2,
            fill: true,
            pointRadius: 0,
            tension: 0.1
        }];

        edcChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: edcData.times.map(t => t.toFixed(2)),
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 600,
                    easing: 'easeOutQuart'
                },
                plugins: {
                    title: {
                        display: !!title,
                        text: title,
                        color: colors.text,
                        font: { size: 13, weight: 600 }
                    },
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0,0,0,0.8)',
                        titleFont: { size: 12 },
                        bodyFont: { size: 11 },
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y.toFixed(1)} dB`
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: '時間 (秒)',
                            color: colors.text,
                            font: { size: 11 }
                        },
                        ticks: {
                            color: colors.text,
                            font: { size: 10 },
                            maxTicksLimit: 10
                        },
                        grid: {
                            color: colors.grid
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'レベル (dB)',
                            color: colors.text,
                            font: { size: 11 }
                        },
                        ticks: {
                            color: colors.text,
                            font: { size: 10 }
                        },
                        grid: {
                            color: colors.grid
                        },
                        min: -80,
                        max: 0
                    }
                }
            }
        });
    }

    /**
     * 時間軸/dB軸グラフの共通オプション
     */
    function timeAxisOptions(colors, yTitle, yMin, yMax, title) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400, easing: 'easeOutQuart' },
            plugins: {
                title: {
                    display: !!title,
                    text: title,
                    color: colors.text,
                    font: { size: 13, weight: 600 }
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: colors.text,
                        font: { size: 11 },
                        usePointStyle: true,
                        pointStyle: 'line'
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    titleFont: { size: 12 },
                    bodyFont: { size: 11 }
                }
            },
            scales: {
                x: {
                    title: { display: true, text: '時間 (秒)', color: colors.text, font: { size: 11 } },
                    ticks: { color: colors.text, font: { size: 10 }, maxTicksLimit: 10 },
                    grid: { color: colors.grid }
                },
                y: {
                    title: { display: true, text: yTitle, color: colors.text, font: { size: 11 } },
                    ticks: { color: colors.text, font: { size: 10 } },
                    grid: { color: colors.grid },
                    min: yMin,
                    max: yMax
                }
            }
        };
    }

    /**
     * インパルス応答の時間波形を描画
     * @param {string} canvasId
     * @param {{times:number[], values:number[]}} irWave
     */
    function drawIRChart(canvasId, irWave) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !irWave || !irWave.times.length) return;

        const colors = getThemeColors();
        if (irChart) irChart.destroy();

        irChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: irWave.times.map(t => t.toFixed(3)),
                datasets: [{
                    label: 'インパルス応答 (正規化振幅)',
                    data: irWave.values,
                    borderColor: colors.ir,
                    backgroundColor: colors.irFill,
                    borderWidth: 1,
                    fill: true,
                    pointRadius: 0,
                    tension: 0
                }]
            },
            options: timeAxisOptions(colors, '振幅', -1.05, 1.05)
        });
    }

    /**
     * インパルス応答のdB表示 (dBエンベロープ + Schroeder積分曲線)
     * @param {string} canvasId
     * @param {{times:number[], envelope:number[], schroeder:number[]}} irDb
     */
    function drawIRDbChart(canvasId, irDb) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !irDb || !irDb.times.length) return;

        const colors = getThemeColors();
        if (irDbChart) irDbChart.destroy();

        irDbChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: irDb.times.map(t => t.toFixed(3)),
                datasets: [
                    {
                        label: 'IRレベル (dB)',
                        data: irDb.envelope,
                        borderColor: colors.ir,
                        backgroundColor: colors.irFill,
                        borderWidth: 1,
                        fill: true,
                        pointRadius: 0,
                        tension: 0
                    },
                    {
                        label: 'Schroeder積分 (EDC)',
                        data: irDb.schroeder,
                        borderColor: colors.schroeder,
                        borderWidth: 2,
                        fill: false,
                        pointRadius: 0,
                        tension: 0.1
                    }
                ]
            },
            options: timeAxisOptions(colors, 'レベル (dB)', -80, 5)
        });
    }

    /**
     * 周波数帯別RT60棒グラフを描画
     */
    function drawBandChart(canvasId, bandsData) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const colors = getThemeColors();

        if (bandChart) {
            bandChart.destroy();
        }

        const labels = Object.keys(bandsData).map(f => {
            const freq = parseInt(f);
            return freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
        });

        const rt60Values = Object.values(bandsData).map(b => {
            return b.valid && !isNaN(b.rt60) ? b.rt60 : 0;
        });

        const edtValues = Object.values(bandsData).map(b => {
            return !isNaN(b.edt) ? b.edt : 0;
        });

        bandChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'RT60',
                        data: rt60Values,
                        backgroundColor: colors.bands.map(c => c + '99'),
                        borderColor: colors.bands,
                        borderWidth: 2,
                        borderRadius: 6,
                        borderSkipped: false
                    },
                    {
                        label: 'EDT',
                        data: edtValues,
                        backgroundColor: colors.bands.map(c => c + '33'),
                        borderColor: colors.bands.map(c => c + '66'),
                        borderWidth: 1,
                        borderRadius: 4,
                        borderSkipped: false
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 800,
                    easing: 'easeOutQuart'
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: colors.text,
                            font: { size: 11, weight: 600 },
                            usePointStyle: true,
                            pointStyle: 'rectRounded'
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0,0,0,0.8)',
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(3)} 秒`
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: '周波数帯 (Hz)',
                            color: colors.text,
                            font: { size: 11 }
                        },
                        ticks: {
                            color: colors.text,
                            font: { size: 10, weight: 600 }
                        },
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: '残響時間 (秒)',
                            color: colors.text,
                            font: { size: 11 }
                        },
                        ticks: {
                            color: colors.text,
                            font: { size: 10 }
                        },
                        grid: {
                            color: colors.grid
                        },
                        beginAtZero: true
                    }
                }
            }
        });
    }

    /**
     * 比較用のオーバーレイグラフ
     */
    function drawComparisonChart(canvasId, datasetsArray) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const colors = getThemeColors();
        const compLabels = AudioUtils.OCTAVE_BANDS.map(f =>
            f >= 1000 ? `${f / 1000}k` : `${f}`
        );

        const datasets = datasetsArray.map((data, idx) => ({
            label: data.name,
            data: AudioUtils.OCTAVE_BANDS.map(f => {
                const band = data.bands[f];
                return band && band.valid && !isNaN(band.rt60) ? band.rt60 : 0;
            }),
            backgroundColor: colors.bands[idx % colors.bands.length] + '66',
            borderColor: colors.bands[idx % colors.bands.length],
            borderWidth: 2,
            borderRadius: 4,
            borderSkipped: false
        }));

        if (bandChart) {
            bandChart.destroy();
        }

        bandChart = new Chart(canvas, {
            type: 'bar',
            data: { labels: compLabels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: colors.text,
                            font: { size: 11 },
                            usePointStyle: true,
                            pointStyle: 'rectRounded'
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0,0,0,0.8)',
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(3)} 秒`
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: colors.text, font: { size: 10, weight: 600 } },
                        grid: { display: false }
                    },
                    y: {
                        title: { display: true, text: '残響時間 (秒)', color: colors.text, font: { size: 11 } },
                        ticks: { color: colors.text, font: { size: 10 } },
                        grid: { color: colors.grid },
                        beginAtZero: true
                    }
                }
            }
        });
    }

    /**
     * テーマ変更時にチャートを更新
     */
    function updateTheme() {
        if (edcChart) {
            const colors = getThemeColors();
            edcChart.options.scales.x.ticks.color = colors.text;
            edcChart.options.scales.y.ticks.color = colors.text;
            edcChart.options.scales.x.grid.color = colors.grid;
            edcChart.options.scales.y.grid.color = colors.grid;
            edcChart.data.datasets[0].borderColor = colors.edcLine;
            edcChart.data.datasets[0].backgroundColor = colors.edcFill;
            edcChart.update('none');
        }
        if (bandChart) {
            const colors = getThemeColors();
            bandChart.options.scales.x.ticks.color = colors.text;
            bandChart.options.scales.y.ticks.color = colors.text;
            bandChart.options.scales.y.grid.color = colors.grid;
            bandChart.update('none');
        }
        [irChart, irDbChart].forEach(chart => {
            if (!chart) return;
            const colors = getThemeColors();
            chart.options.scales.x.ticks.color = colors.text;
            chart.options.scales.y.ticks.color = colors.text;
            chart.options.scales.x.grid.color = colors.grid;
            chart.options.scales.y.grid.color = colors.grid;
            chart.options.plugins.legend.labels.color = colors.text;
            chart.update('none');
        });
    }

    /**
     * チャートを破棄
     */
    function destroyCharts() {
        if (edcChart) { edcChart.destroy(); edcChart = null; }
        if (bandChart) { bandChart.destroy(); bandChart = null; }
        if (irChart) { irChart.destroy(); irChart = null; }
        if (irDbChart) { irDbChart.destroy(); irDbChart = null; }
    }

    return {
        initWaveform,
        drawWaveform,
        drawEDCChart,
        drawIRChart,
        drawIRDbChart,
        drawBandChart,
        drawComparisonChart,
        updateTheme,
        destroyCharts
    };
})();
