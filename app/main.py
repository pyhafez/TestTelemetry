from pathlib import Path

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from . import sources
from .metrics import compute_metrics, get_test_log, SchemaError

APP_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Test Telemetry Dashboard")
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
templates = Jinja2Templates(directory=APP_DIR / "templates")


class RemoteLoadRequest(BaseModel):
    url: str


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/test")
async def test_case_page(request: Request):
    return templates.TemplateResponse("test_case.html", {"request": request})


@app.get("/api/sources")
async def api_list_sources():
    entries = await sources.list_sources()
    entries = sorted(entries, key=lambda e: e["added_at"], reverse=True)
    return entries


@app.post("/api/sources/upload")
async def api_upload_source(file: UploadFile = File(...)):
    contents = await file.read()
    try:
        entry = await sources.add_upload(name=file.filename or "upload.db", contents=contents)
    except SchemaError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return entry


@app.post("/api/sources/remote")
async def api_load_remote(body: RemoteLoadRequest):
    try:
        entry = await sources.add_remote(body.url)
    except sources.RemoteFetchError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return entry


@app.delete("/api/sources/{source_id}")
async def api_delete_source(source_id: str):
    ok = await sources.delete_source(source_id)
    if not ok:
        return JSONResponse({"error": "not found"}, status_code=404)
    return {"deleted": source_id}


@app.get("/api/sources/{source_id}/data")
async def api_source_data(source_id: str):
    entry = await sources.get_source(source_id)
    if not entry:
        return JSONResponse({"error": "not found"}, status_code=404)
    db_path = sources.source_db_path(entry)
    if not db_path.exists():
        return JSONResponse({"error": "source file missing on disk"}, status_code=410)
    try:
        data = compute_metrics(db_path)
    except Exception as e:
        return JSONResponse({"error": f"failed to read database: {e}"}, status_code=500)
    data["source"] = entry
    return data


@app.get("/api/sources/{source_id}/tests/log")
async def api_test_log(source_id: str, nodeid: str, run_id: int):
    """Captured stdout/stderr/log output/failure traceback for one test's
    execution in one run. Lazily fetched by the test case page so the
    main dashboard payload stays light even when logs are large."""
    entry = await sources.get_source(source_id)
    if not entry:
        return JSONResponse({"error": "not found"}, status_code=404)
    db_path = sources.source_db_path(entry)
    if not db_path.exists():
        return JSONResponse({"error": "source file missing on disk"}, status_code=410)
    try:
        return get_test_log(db_path, run_id, nodeid)
    except Exception as e:
        return JSONResponse({"error": f"failed to read log: {e}"}, status_code=500)
