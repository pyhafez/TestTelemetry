# Test telemetry dashboard service

A FastAPI service for your pytest run history. It:

- Serves a dashboard (pass/fail trend, suite duration trend, duration
  distribution, slowest tests, a configurable flaky-test heatmap).
- Accepts file uploads (`POST /api/sources/upload`) and remote URLs
  (`POST /api/sources/remote`) — useful if CI publishes
  `test_history.db` as a build artifact.
- Treats each test case as its own object: total executions, pass
  rate, outcome transitions, a configurable flakiness threshold, and
  — new — its full captured log per run.
- Click any row in the Test outcome grid to open that test's own page
  (`/test?source=<id>&nodeid=<nodeid>`) with a duration trend and a
  run-by-run history table. Click a row in that table to expand its
  captured stdout, stderr, log output, and failure traceback.
- Has no external runtime dependencies — Chart.js is bundled locally.

## Capturing test logs

Logs don't show up by magic — something has to capture them during
the pytest run and write them into `test_history.db`. That's what
`pytest_integration/conftest.py` does. Drop it into the root of your
pytest suite (or merge its hooks into your existing conftest.py if you
already have one building run history):

```bash
cp pytest_integration/conftest.py /path/to/your/suite/conftest.py
```

Then just run pytest as normal:

```bash
pytest --history-db=test_history.db
# or: TEST_HISTORY_DB=test_history.db pytest
```

What it captures, per test, per run:
- **stdout / stderr** — anything printed during the test
- **log output** — anything sent through Python's `logging` module
  (captured the same way `caplog` sees it)
- **failure traceback** (`longrepr`) — pytest's full failure
  representation, only populated for failed tests

Only the `call` phase is recorded for passing tests (setup/teardown
noise isn't interesting when nothing went wrong); a `setup` or
`teardown` phase is recorded too if *it* is what failed, since that's
exactly the case where there'd otherwise be no `call` row at all to
look at.

**If you already have a `test_history.db`** from before this feature
existed (it only had `runs` and `test_results` with a bare `longrepr`
column), nothing breaks. The conftest migrates the schema in place the
first time it runs against that file — old rows are untouched, new
columns (`stdout`, `stderr`, `log_output`) are added, and new runs
start populating them. I tested this migration directly against a
3-run, 36-result db with the old schema: it came out with the same 3
runs intact plus a 4th with full log data, no data loss.

Log size is capped at 20,000 characters per field (configurable via
`MAX_LOG_CHARS` in the conftest) so one chatty test can't blow up your
db — truncation is marked explicitly, never silent.

On the dashboard, a source that was captured without these columns
still works exactly as before — the service detects their absence
(`has_logs: false` in the API payload) and the test case page says so
plainly instead of showing empty log panels.

## What I can and can't do here

I can't stand up a public, always-on server myself — this environment
has no persistent hosting. What I can do is hand you a complete,
tested service that you point at any always-on host for 24/7
availability.

**Note on this delivery:** I ran the actual app end-to-end in this
sandbox (uvicorn directly, real HTTP requests, a real pytest run
against the conftest, a DOM-level test of the log viewer's
expand/collapse), but Docker's daemon isn't available in this sandbox,
so I could not build/run the container itself here. The Dockerfile is
unchanged from a version that's been used before — standard
`python:3.11-slim` + pip install + uvicorn — but you should do a
`docker compose up -d --build` smoke test on your end before relying
on it.

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000`.

## Getting to 24/7 availability

**Fastest: Fly.io / Railway / Render** — build directly from the
`Dockerfile`:
```bash
fly launch
fly volumes create data --size 1     # persistent storage for data/
fly deploy
```
Attach a persistent volume mounted at `/app/data` on whichever
platform you use, or uploaded sources won't survive a redeploy.

**Full control: a small VPS**
```bash
git clone <your repo> && cd service
docker compose up -d --build
```
Put Caddy or nginx in front for HTTPS:
```
your-domain.com {
    reverse_proxy localhost:8000
}
```

**No Docker: plain systemd**
```ini
[Unit]
Description=test-telemetry-dashboard
After=network.target

[Service]
WorkingDirectory=/opt/dashboard
ExecStart=/opt/dashboard/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

## Security notes — read before exposing this publicly

- **No authentication is built in.** Put it behind a login or
  restrict it to your VPN/office IP range if it'll be internet-facing.
- **The remote-URL loader has an SSRF guard**: it resolves the
  hostname and refuses private/loopback/link-local/reserved
  addresses, re-validated on every redirect hop. It does not restrict
  *which* public hosts are allowed — add an allowlist in
  `app/sources.py::_validate_url` if you want to lock it to a specific
  CI artifact host.
  - If your test server lives on a private/internal address (e.g.
    `192.168.x.x`) that the dashboard legitimately needs to reach, set
    `ALLOWED_PRIVATE_NETWORKS` to a comma-separated list of CIDR
    ranges (e.g. `192.168.48.0/24,10.0.0.0/8`) to carve out just that
    network — everything else private/reserved stays blocked.
  - If the dashboard itself is deployed inside your trusted network
    and the private-address restriction doesn't apply at all, set
    `ALLOW_PRIVATE_SOURCES=true` to disable the check entirely. Only
    do this if the dashboard isn't reachable from untrusted networks.
- Remote fetches are capped at 100MB / 20s timeout
  (`app/sources.py`).
- Uploaded/fetched files are schema-validated before acceptance.
- **Logs can contain sensitive data** — stdout/stderr/tracebacks might
  include request payloads, tokens, internal hostnames, whatever your
  tests happen to print. If that's a concern, scrub before capture
  (redact in the test itself) rather than after — there's no
  redaction step in the conftest today.

## Test case model and flakiness

Each test case (by pytest `nodeid`) is its own object, computed from
its full run history:

- **Total executions**, pass/fail/skip counts, pass rate
- **Transitions** — how many times its outcome changed between
  consecutive runs it executed in
- **Flaky** — `transitions >= your threshold`, a control in the UI
  ("Flaky at N+ flips"), persisted per-browser, shared between the
  dashboard and the test case page. A single blip and a test that
  flips every run are different problems; the threshold is how you
  tell them apart.
- **Captured log** — fetched lazily per run when you expand a row on
  the test case page, not bundled into the main dashboard payload (so
  large logs don't slow down the heatmap).

## Project layout

```
app/
  main.py              FastAPI routes
  sources.py           upload/remote-fetch handling, SSRF guard, manifest
  metrics.py           schema validation, chart data, per-test log lookup
  static/              Chart.js (bundled), CSS, dashboard + test-case JS
  templates/            index.html (dashboard), test_case.html (per-test page)
pytest_integration/
  conftest.py          drop-in capture plugin — runs, results, and logs
data/                  runtime storage (gitignore this; mount as a volume)
Dockerfile
docker-compose.yml
requirements.txt
```
