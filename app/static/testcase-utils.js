/**
 * Shared by the dashboard heatmap and the test case detail page.
 * A "transition" is any change in outcome between two consecutive
 * runs the test actually executed in (skipped/missing runs don't
 * count as an outcome and are ignored when comparing neighbors).
 * "Flaky" is not a fixed rule — it's transitions >= a threshold the
 * user sets, so a single pass->fail blip can be excluded by raising
 * the threshold above 1.
 */
function countTransitions(cells) {
  let transitions = 0;
  let prev = null;
  cells.forEach(cell => {
    if (!cell) return;
    if (prev !== null && cell.outcome !== prev) transitions++;
    prev = cell.outcome;
  });
  return transitions;
}

function computeTestCaseStats(cells, threshold) {
  const executed = cells.filter(c => c);
  const passed = executed.filter(c => c.outcome === 'passed').length;
  const failed = executed.filter(c => c.outcome === 'failed').length;
  const skipped = executed.filter(c => c.outcome === 'skipped').length;
  const durations = executed.map(c => c.duration).filter(d => d !== null && d !== undefined);
  const transitions = countTransitions(cells);
  return {
    total_executions: executed.length,
    passed, failed, skipped,
    pass_rate: executed.length ? Math.round(1000 * passed / executed.length) / 10 : 0,
    transitions,
    is_flaky: transitions >= threshold,
    avg_duration: durations.length ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2) : 0,
    min_duration: durations.length ? +Math.min(...durations).toFixed(2) : 0,
    max_duration: durations.length ? +Math.max(...durations).toFixed(2) : 0,
  };
}

const FLAKY_THRESHOLD_KEY = 'flakyThreshold';
function getSavedFlakyThreshold() {
  try {
    const v = parseInt(localStorage.getItem(FLAKY_THRESHOLD_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : 1;
  } catch (e) { return 1; }
}
function saveFlakyThreshold(v) {
  try { localStorage.setItem(FLAKY_THRESHOLD_KEY, String(v)); } catch (e) { /* ignore */ }
}
