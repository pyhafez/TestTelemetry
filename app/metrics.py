"""
Schema validation and metrics computation for test_history.db-shaped
sqlite files. Any source (uploaded or fetched remotely) goes through
validate_schema() before it is accepted, and compute_metrics() turns
a raw db into the exact JSON shape the dashboard frontend expects.

Per-test log capture (stdout/stderr/log output/failure traceback) is
optional: older db files only have `longrepr`, newer ones captured
with pytest_integration/conftest.py also have `stdout`, `stderr` and
`log_output`. Everything here degrades gracefully when a column is
missing rather than rejecting the file.
"""
import sqlite3
from pathlib import Path

REQUIRED_TABLES = {
    "runs": {"id", "timestamp", "passed", "failed", "skipped", "duration", "total"},
    "test_results": {"run_id", "nodeid", "outcome", "duration", "phase"},
}

# Columns that enrich a test case's detail page when present, but are
# never required for a db file to be accepted.
OPTIONAL_LOG_COLUMNS = ["longrepr", "stdout", "stderr", "log_output"]


class SchemaError(ValueError):
    pass


def _table_columns(cur, table: str) -> set[str]:
    cur.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cur.fetchall()}


def validate_schema(db_path: Path) -> None:
    """Raise SchemaError if the file isn't a sqlite db or is missing the
    tables/columns the dashboard depends on. Log columns are optional
    and never block acceptance."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error as e:
        raise SchemaError(f"Not a readable sqlite database: {e}")

    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row[0] for row in cur.fetchall()}
        for table, required_cols in REQUIRED_TABLES.items():
            if table not in tables:
                raise SchemaError(f"Missing required table '{table}'")
            cols = _table_columns(cur, table)
            missing = required_cols - cols
            if missing:
                raise SchemaError(f"Table '{table}' is missing columns: {sorted(missing)}")
    except sqlite3.DatabaseError as e:
        raise SchemaError(f"Not a valid sqlite database: {e}")
    finally:
        conn.close()


def _short_name(nodeid: str) -> str:
    tail = nodeid.split("::")[-1]
    return tail.split("[")[0] or nodeid


def compute_metrics(db_path: Path) -> dict:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT id, timestamp, passed, failed, skipped, duration, total FROM runs ORDER BY timestamp")
    runs = [dict(r) for r in cur.fetchall()]

    available_cols = _table_columns(cur, "test_results")
    has_logs = any(c in available_cols for c in ("stdout", "stderr", "log_output", "longrepr"))

    cur.execute("SELECT run_id, nodeid, outcome, duration, phase FROM test_results")
    results = [dict(r) for r in cur.fetchall()]
    conn.close()

    results = [r for r in results if r.get("phase") in (None, "", "call")]

    if not runs:
        return {"empty": True}

    total_passed = sum(r["passed"] for r in runs)
    total_failed = sum(r["failed"] for r in runs)
    total_skipped = sum(r["skipped"] for r in runs)
    total_tests = total_passed + total_failed + total_skipped
    pass_rate = round(1000 * total_passed / total_tests) / 10 if total_tests else 0

    dur_by_run = {}
    for r in results:
        dur_by_run[r["run_id"]] = dur_by_run.get(r["run_id"], 0) + (r["duration"] or 0)
    avg_suite_duration = (
        sum(dur_by_run.get(r["id"], r["duration"] or 0) for r in runs) / len(runs)
        if runs else 0
    )

    by_node: dict[str, list[dict]] = {}
    for r in results:
        by_node.setdefault(r["nodeid"], []).append(r)
    flaky_count = sum(1 for arr in by_node.values() if len({a["outcome"] for a in arr}) > 1)

    labels = [r["timestamp"] for r in runs]

    outcomes = {
        "labels": labels,
        "passed": [r["passed"] for r in runs],
        "failed": [r["failed"] for r in runs],
        "skipped": [r["skipped"] for r in runs],
    }

    duration_trend = {
        "labels": labels,
        "values": [round(dur_by_run.get(r["id"], r["duration"] or 0), 2) for r in runs],
    }

    durations = [r["duration"] or 0 for r in results if (r["duration"] or 0) > 0]
    histogram = {"labels": [], "counts": []}
    if durations:
        lo, hi = min(durations), max(durations)
        bins = 8
        width = (hi - lo) / bins or 1
        counts = [0] * bins
        for d in durations:
            idx = min(int((d - lo) / width), bins - 1)
            counts[max(idx, 0)] += 1
        histogram["labels"] = [f"{lo + i * width:.1f}-{lo + (i + 1) * width:.1f}s" for i in range(bins)]
        histogram["counts"] = counts

    slowest_nodes = sorted(
        by_node.items(),
        key=lambda kv: max((a["duration"] or 0) for a in kv[1]),
        reverse=True,
    )[:6]
    slowest = {
        "labels": labels,
        "series": [
            {
                "name": _short_name(nodeid),
                "data": [
                    (round(next((a["duration"] for a in arr if a["run_id"] == r["id"]), None), 2)
                     if any(a["run_id"] == r["id"] for a in arr) else None)
                    for r in runs
                ],
            }
            for nodeid, arr in slowest_nodes
        ],
    }

    heatmap_rows = []
    for nodeid, arr in by_node.items():
        by_run = {a["run_id"]: a for a in arr}
        cells = []
        for r in runs:
            match = by_run.get(r["id"])
            if match:
                cells.append({
                    "run_id": r["id"],
                    "outcome": match["outcome"],
                    "duration": round(match["duration"] or 0, 2),
                })
            else:
                cells.append(None)
        heatmap_rows.append({"nodeid": nodeid, "short_name": _short_name(nodeid), "cells": cells})

    return {
        "empty": False,
        "has_logs": has_logs,
        "summary": {
            "run_count": len(runs),
            "pass_rate": pass_rate,
            "avg_suite_duration": round(avg_suite_duration, 1),
            "flaky_count": flaky_count,
            "last_run_ts": runs[-1]["timestamp"],
            "distinct_tests": len(by_node),
            "result_count": len(results),
        },
        "run_labels": labels,
        "outcomes": outcomes,
        "duration_trend": duration_trend,
        "histogram": histogram,
        "slowest": slowest,
        "heatmap": heatmap_rows,
    }


def get_test_log(db_path: Path, run_id: int, nodeid: str) -> dict:
    """Fetch captured log content for one (run_id, nodeid) execution.
    Returns which columns were actually available in this db file so
    the frontend can distinguish "empty output" from "never captured"."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        available = _table_columns(cur, "test_results")
        present_cols = [c for c in OPTIONAL_LOG_COLUMNS if c in available]
        if not present_cols:
            return {
                "found": False,
                "captured": False,
                "reason": "This source was captured without log columns (stdout/stderr/log_output/longrepr). "
                          "Re-run with the updated pytest_integration/conftest.py to capture logs going forward.",
            }
        # Prefer the 'call' phase row (the normal case), but fall back to
        # whatever's there (e.g. a setup failure has no 'call' row at all).
        cur.execute(
            f"SELECT {', '.join(present_cols)} FROM test_results WHERE run_id = ? AND nodeid = ? "
            f"ORDER BY CASE phase WHEN 'call' THEN 0 WHEN '' THEN 1 WHEN NULL THEN 1 ELSE 2 END, id DESC LIMIT 1",
            (run_id, nodeid),
        )
        row = cur.fetchone()
        if row is None:
            return {"found": False, "captured": True, "reason": "No matching test execution for this run."}
        values = dict(zip(present_cols, row))
        for col in OPTIONAL_LOG_COLUMNS:
            values.setdefault(col, None)
        return {"found": True, "captured": True, **values}
    finally:
        conn.close()
