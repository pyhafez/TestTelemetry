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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function chartOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#7C8797', font: { size: 10 } }, grid: { color: '#1B222C' } },
      y: { beginAtZero: true, ticks: { color: '#7C8797', font: { size: 10 } }, grid: { color: '#1B222C' } },
    },
  };
}

let tcChart = null;
let currentRow = null;
let currentRunLabels = null;
let currentSourceId = null;
const logCache = {}; // run_id -> fetched log payload

function params() {
  const p = new URLSearchParams(window.location.search);
  return { source: p.get('source'), nodeid: p.get('nodeid') };
}

async function load() {
  const { source, nodeid } = params();
  if (!source || !nodeid) {
    setStatus('Missing source or test case in the URL.', 'error');
    document.getElementById('loadingState').textContent = 'Nothing to show — go back and click a test in the grid.';
    return;
  }
  currentSourceId = source;
  document.getElementById('backLink').href = '/';

  const res = await fetch(`/api/sources/${source}/data`);
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Failed to load source', 'error');
    return;
  }
  const row = data.heatmap.find(r => r.nodeid === nodeid);
  if (!row) {
    setStatus('Could not find this test case in the selected source.', 'error');
    return;
  }

  currentRow = row;
  currentRunLabels = data.run_labels;
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('tcContent').style.display = 'block';
  document.getElementById('tcTitle').textContent = row.short_name;
  document.getElementById('tcNodeid').textContent = row.nodeid;

  if (!data.has_logs) {
    document.getElementById('logAvailabilityNote').textContent =
      'This source was captured without log columns — upgrade your conftest.py (see pytest_integration/) to capture logs for future runs.';
  }

  document.getElementById('flakyThreshold').value = getSavedFlakyThreshold();
  render(data.has_logs);
}

function render(hasLogs) {
  const threshold = Math.max(1, parseInt(document.getElementById('flakyThreshold').value, 10) || 1);
  const stats = computeTestCaseStats(currentRow.cells, threshold);

  const badge = stats.is_flaky
    ? `<span class="tc-badge flaky">flaky &middot; ${stats.transitions} flips</span>`
    : `<span class="tc-badge stable">stable &middot; ${stats.transitions} flips</span>`;
  document.getElementById('tcTitle').innerHTML = `${currentRow.short_name} ${badge}`;

  document.getElementById('tcSummary').innerHTML = `
    <div class="stat"><div class="label">Executed</div><div class="value">${stats.total_executions}</div></div>
    <div class="stat"><div class="label">Pass rate</div><div class="value ${stats.pass_rate === 100 ? 'pass' : (stats.pass_rate < 80 ? 'fail' : '')}">${stats.pass_rate}%</div></div>
    <div class="stat"><div class="label">Passed / Failed / Skipped</div><div class="value" style="font-size:16px">${stats.passed} / ${stats.failed} / ${stats.skipped}</div></div>
    <div class="stat"><div class="label">Avg duration</div><div class="value">${stats.avg_duration}s</div></div>
    <div class="stat"><div class="label">Min / Max duration</div><div class="value" style="font-size:16px">${stats.min_duration}s / ${stats.max_duration}s</div></div>
  `;

  const labels = currentRunLabels.map(fmtTime);
  const durations = currentRow.cells.map(c => (c ? c.duration : null));
  if (tcChart) tcChart.destroy();
  tcChart = new Chart(document.getElementById('chartTcDuration'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Duration (s)',
        data: durations,
        borderColor: '#4C9FE8',
        backgroundColor: 'rgba(76,159,232,0.12)',
        fill: true,
        tension: 0.25,
        pointRadius: 3,
        spanGaps: true,
      }],
    },
    options: chartOpts(),
  });

  let html = '<thead><tr><th>Run</th><th>Outcome</th><th>Duration</th><th></th></tr></thead><tbody>';
  currentRunLabels.forEach((ts, i) => {
    const cell = currentRow.cells[i];
    if (cell) {
      html += `<tr class="log-row" data-run-id="${cell.run_id}">` +
        `<td>${fmtTime(ts)}</td>` +
        `<td><span class="outcome-badge ${cell.outcome}">${cell.outcome}</span></td>` +
        `<td>${cell.duration}s</td>` +
        `<td class="expand-hint">${hasLogs ? 'view log &rsaquo;' : ''}</td>` +
        `</tr>` +
        `<tr class="log-detail-row" data-run-id="${cell.run_id}" style="display:none"><td colspan="4"><div class="log-detail"></div></td></tr>`;
    } else {
      html += `<tr class="log-row disabled"><td>${fmtTime(ts)}</td><td><span class="outcome-badge missing">not run</span></td><td>&mdash;</td><td></td></tr>`;
    }
  });
  html += '</tbody>';
  const table = document.getElementById('historyTable');
  table.innerHTML = html;

  table.querySelectorAll('tr.log-row[data-run-id]').forEach(tr => {
    tr.addEventListener('click', () => toggleLog(tr.dataset.runId));
  });
}

async function toggleLog(runId) {
  const detailRow = document.querySelector(`tr.log-detail-row[data-run-id="${runId}"]`);
  if (!detailRow) return;
  const visible = detailRow.style.display !== 'none';
  if (visible) {
    detailRow.style.display = 'none';
    return;
  }
  // Collapse any other open row so only one log is open at a time.
  document.querySelectorAll('tr.log-detail-row').forEach(r => { r.style.display = 'none'; });
  detailRow.style.display = '';
  const container = detailRow.querySelector('.log-detail');

  if (logCache[runId]) {
    renderLog(container, logCache[runId]);
    return;
  }
  container.innerHTML = '<div class="log-loading">Loading log&hellip;</div>';
  try {
    const url = `/api/sources/${currentSourceId}/tests/log?nodeid=${encodeURIComponent(currentRow.nodeid)}&run_id=${encodeURIComponent(runId)}`;
    const res = await fetch(url);
    const payload = await res.json();
    if (!res.ok) {
      container.innerHTML = `<div class="log-not-captured">${escapeHtml(payload.error || 'Failed to load log')}</div>`;
      return;
    }
    logCache[runId] = payload;
    renderLog(container, payload);
  } catch (e) {
    container.innerHTML = `<div class="log-not-captured">Failed to load log: ${escapeHtml(e.message)}</div>`;
  }
}

function logSection(title, content, isFailure) {
  if (content === null || content === undefined || content === '') return '';
  const id = 'log-' + Math.random().toString(36).slice(2, 9);
  return `
    <div class="log-section">
      <p class="log-section-title${isFailure ? ' failed' : ''}">
        ${title}
        <button class="log-copy-btn" data-copy-target="${id}" type="button">Copy</button>
      </p>
      <pre id="${id}">${escapeHtml(content)}</pre>
    </div>`;
}

function renderLog(container, payload) {
  if (!payload.captured) {
    container.innerHTML = `<div class="log-not-captured">${escapeHtml(payload.reason || 'Logs were not captured for this source.')}</div>`;
    return;
  }
  if (!payload.found) {
    container.innerHTML = `<div class="log-not-captured">${escapeHtml(payload.reason || 'No log found for this run.')}</div>`;
    return;
  }

  const sections = [
    logSection('Failure', payload.longrepr, true),
    logSection('stdout', payload.stdout, false),
    logSection('stderr', payload.stderr, false),
    logSection('log output', payload.log_output, false),
  ].join('');

  container.innerHTML = sections || '<div class="log-empty">No output was captured for this run (test produced no stdout/stderr/log output).</div>';

  container.querySelectorAll('.log-copy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pre = document.getElementById(btn.dataset.copyTarget);
      navigator.clipboard?.writeText(pre.textContent).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = original; }, 1200);
      }).catch(() => { /* clipboard unavailable, ignore */ });
    });
  });
}

document.getElementById('flakyThreshold').addEventListener('change', e => {
  const v = Math.max(1, parseInt(e.target.value, 10) || 1);
  e.target.value = v;
  saveFlakyThreshold(v);
  if (currentRow) render(true);
});

load();
