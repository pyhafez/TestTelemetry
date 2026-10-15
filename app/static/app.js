let charts = [];
let currentSources = [];
let currentData = null;
let currentSourceId = null;

const HEATMAP_LIMIT_KEY = 'heatmapRunLimit';
function getSavedHeatmapLimit() {
  try { return localStorage.getItem(HEATMAP_LIMIT_KEY) || '10'; }
  catch (e) { return '10'; }
}
function saveHeatmapLimit(v) {
  try { localStorage.setItem(HEATMAP_LIMIT_KEY, v); } catch (e) { /* ignore */ }
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function setStatus(msg, kind) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function destroyCharts() {
  charts.forEach(c => c.destroy());
  charts = [];
}
function chartOpts({ stacked = false, legend = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: legend, labels: { color: '#7C8797', font: { size: 10 }, boxWidth: 10 } },
    },
    scales: {
      x: { stacked, ticks: { color: '#7C8797', font: { size: 10 } }, grid: { color: '#1B222C' } },
      y: { stacked, beginAtZero: true, ticks: { color: '#7C8797', font: { size: 10 } }, grid: { color: '#1B222C' } },
    },
  };
}

async function refreshSourceList(selectId) {
  const res = await fetch('/api/sources');
  currentSources = await res.json();
  const picker = document.getElementById('sourcePicker');
  picker.innerHTML = '<option value="">Select a source&hellip;</option>';
  currentSources.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    const kindTag = s.kind === 'remote' ? 'remote' : 'upload';
    opt.textContent = `${s.name} (${kindTag}, ${fmtTime(s.added_at)})`;
    picker.appendChild(opt);
  });
  if (selectId) {
    picker.value = selectId;
    await loadSourceData(selectId);
  }
}

async function loadSourceData(sourceId) {
  currentSourceId = sourceId || null;
  if (!sourceId) {
    document.getElementById('dash').style.display = 'none';
    document.getElementById('emptyState').style.display = 'block';
    return;
  }
  const res = await fetch(`/api/sources/${sourceId}/data`);
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Failed to load source', 'error');
    return;
  }
  if (data.empty) {
    setStatus('This source has no runs recorded yet.', 'error');
    return;
  }
  setStatus('');
  render(data);
}

function render(data) {
  currentData = data;
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('dash').style.display = 'block';
  destroyCharts();

  const s = data.summary;
  const threshold = getFlakyThresholdInput();
  const flakyCount = data.heatmap.filter(row => countTransitions(row.cells) >= threshold).length;
  document.getElementById('summary').innerHTML = `
    <div class="stat"><div class="label">Runs recorded</div><div class="value">${s.run_count}</div></div>
    <div class="stat"><div class="label">Overall pass rate</div><div class="value ${s.pass_rate === 100 ? 'pass' : (s.pass_rate < 80 ? 'fail' : '')}">${s.pass_rate}%</div></div>
    <div class="stat"><div class="label">Avg suite duration</div><div class="value">${s.avg_suite_duration}s</div></div>
    <div class="stat"><div class="label">Flaky tests</div><div class="value ${flakyCount > 0 ? 'flaky' : ''}">${flakyCount}</div></div>
    <div class="stat"><div class="label">Last run</div><div class="value" style="font-size:14px">${fmtTime(s.last_run_ts)}</div></div>
  `;

  const labels = data.run_labels.map(fmtTime);

  charts.push(new Chart(document.getElementById('chartOutcomes'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Passed', data: data.outcomes.passed, backgroundColor: '#33C9A0' },
        { label: 'Failed', data: data.outcomes.failed, backgroundColor: '#E8574A' },
        { label: 'Skipped', data: data.outcomes.skipped, backgroundColor: '#D9A63D' },
      ],
    },
    options: chartOpts({ stacked: true }),
  }));

  charts.push(new Chart(document.getElementById('chartDuration'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Suite duration (s)',
        data: data.duration_trend.values,
        borderColor: '#4C9FE8',
        backgroundColor: 'rgba(76,159,232,0.12)',
        fill: true,
        tension: 0.25,
        pointRadius: 3,
      }],
    },
    options: chartOpts({}),
  }));

  charts.push(new Chart(document.getElementById('chartHist'), {
    type: 'bar',
    data: { labels: data.histogram.labels, datasets: [{ label: 'Test count', data: data.histogram.counts, backgroundColor: '#4C9FE8' }] },
    options: chartOpts({}),
  }));

  const palette = ['#4C9FE8', '#33C9A0', '#D9A63D', '#E8574A', '#8C7AE6', '#3DBEDC'];
  charts.push(new Chart(document.getElementById('chartSlow'), {
    type: 'line',
    data: {
      labels,
      datasets: data.slowest.series.map((series, i) => ({
        label: series.name,
        data: series.data,
        borderColor: palette[i % palette.length],
        backgroundColor: 'transparent',
        tension: 0.25,
        pointRadius: 2,
      })),
    },
    options: chartOpts({ legend: true }),
  }));

  renderHeatmap(data);

  document.getElementById('footerNote').textContent =
    `${data.source.name} · ${s.run_count} runs · ${s.distinct_tests} distinct tests · ${s.result_count} results loaded` +
    (data.has_logs ? ' · logs captured' : ' · no logs captured for this source');
}

function getFlakyThresholdInput() {
  const el = document.getElementById('flakyThreshold');
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function goToTestCase(sourceId, nodeid) {
  window.location.href = `/test?source=${encodeURIComponent(sourceId)}&nodeid=${encodeURIComponent(nodeid)}`;
}

function renderHeatmap(data) {
  const total = data.run_labels.length;
  const select = document.getElementById('heatmapLimit');
  const raw = select.value;
  const n = raw === 'all' ? total : Math.min(parseInt(raw, 10) || total, total);
  const startIdx = total - n;
  const threshold = getFlakyThresholdInput();

  const labels = data.run_labels.slice(startIdx).map(fmtTime);

  let html = '<table class="heatmap"><thead><tr><th></th>';
  labels.forEach(l => { html += `<th>${l}</th>`; });
  html += '</tr></thead><tbody>';
  data.heatmap.forEach(row => {
    // Flaky status is computed over the test's FULL run history, independent
    // of how many columns are currently visible in the grid.
    const isFlaky = countTransitions(row.cells) >= threshold;
    html += `<tr class="${isFlaky ? 'flaky-row' : ''}" data-nodeid="${encodeURIComponent(row.nodeid)}">`;
    html += `<td class="rowlabel" title="${row.nodeid} &mdash; click for full history and logs">${row.short_name}</td>`;
    row.cells.slice(startIdx).forEach(cell => {
      if (cell) {
        html += `<td><div class="cell ${cell.outcome}" title="${cell.outcome} &middot; ${cell.duration}s"></div></td>`;
      } else {
        html += `<td><div class="cell missing" title="not run"></div></td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  const heatmapEl = document.getElementById('heatmap');
  heatmapEl.innerHTML = html;
  heatmapEl.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', () => goToTestCase(currentSourceId, decodeURIComponent(tr.dataset.nodeid)));
  });

  const note = document.getElementById('heatmapRangeNote');
  note.textContent = n < total ? `Showing ${n} of ${total} runs` : `Showing all ${total} runs`;
}

document.getElementById('sourcePicker').addEventListener('change', e => loadSourceData(e.target.value));

document.getElementById('heatmapLimit').value = getSavedHeatmapLimit();
document.getElementById('heatmapLimit').addEventListener('change', e => {
  saveHeatmapLimit(e.target.value);
  if (currentData) renderHeatmap(currentData);
});

document.getElementById('flakyThreshold').value = getSavedFlakyThreshold();
document.getElementById('flakyThreshold').addEventListener('change', e => {
  const v = Math.max(1, parseInt(e.target.value, 10) || 1);
  e.target.value = v;
  saveFlakyThreshold(v);
  if (currentData) render(currentData);
});

document.getElementById('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('Uploading&hellip;');
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/sources/upload', { method: 'POST', body: form });
  const entry = await res.json();
  if (!res.ok) {
    setStatus(entry.error || 'Upload failed', 'error');
    return;
  }
  setStatus(`Loaded ${entry.name}`, 'ok');
  await refreshSourceList(entry.id);
  e.target.value = '';
});

document.getElementById('loadRemoteBtn').addEventListener('click', async () => {
  const url = document.getElementById('remoteUrl').value.trim();
  if (!url) return;
  setStatus('Fetching remote database&hellip;');
  const res = await fetch('/api/sources/remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const entry = await res.json();
  if (!res.ok) {
    setStatus(entry.error || 'Remote load failed', 'error');
    return;
  }
  setStatus(`Loaded ${entry.name} from remote`, 'ok');
  await refreshSourceList(entry.id);
});

refreshSourceList();
