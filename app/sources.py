"""
Manages the set of loaded db sources (uploaded or fetched from a remote
URL) and enforces basic SSRF protection on the remote-fetch path.
"""
import asyncio
import ipaddress
import json
import os
import socket
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .metrics import SchemaError, validate_schema

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SOURCES_DIR = DATA_DIR / "sources"
MANIFEST_PATH = DATA_DIR / "sources.json"

MAX_REMOTE_BYTES = 100 * 1024 * 1024  # 100 MB cap
REMOTE_TIMEOUT_SECONDS = 20

# --- SSRF guard escape hatches -------------------------------------------
#
# By default, the remote-fetch path refuses any host that resolves to a
# private/loopback/link-local/reserved address, since otherwise anything
# with access to the dashboard could point it at internal-only services.
#
# Two opt-in ways to relax that, for deployments where the dashboard and
# its test sources legitimately live on the same private network:
#
#   ALLOWED_PRIVATE_NETWORKS   Comma-separated list of CIDR ranges (e.g.
#                              "192.168.48.0/24,10.0.0.0/8") that are
#                              allowed even though they're private. Only
#                              addresses inside these ranges are exempted;
#                              every other private/reserved address is
#                              still blocked.
#
#   ALLOW_PRIVATE_SOURCES      "true"/"1" disables the private-address
#                              check entirely. Use only when the dashboard
#                              itself is deployed inside the trusted
#                              network (e.g. office LAN, VPN-only) and the
#                              restriction doesn't apply.
#
# Both are read at call time (not just import time) so they can be changed
# without restarting the process in dev, and so tests can monkeypatch the
# env var directly.


def _allowed_private_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    raw = os.environ.get("ALLOWED_PRIVATE_NETWORKS", "")
    networks = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            networks.append(ipaddress.ip_network(chunk, strict=False))
        except ValueError:
            # Bad config shouldn't silently widen access; skip the entry
            # rather than raise, since this runs on every fetch.
            continue
    return networks


def _allow_private_sources() -> bool:
    return os.environ.get("ALLOW_PRIVATE_SOURCES", "").strip().lower() in ("1", "true", "yes")


_lock = asyncio.Lock()


class RemoteFetchError(ValueError):
    pass


def _ensure_dirs():
    SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    if not MANIFEST_PATH.exists():
        MANIFEST_PATH.write_text("[]")


def _read_manifest() -> list[dict]:
    _ensure_dirs()
    return json.loads(MANIFEST_PATH.read_text())


def _write_manifest(entries: list[dict]) -> None:
    MANIFEST_PATH.write_text(json.dumps(entries, indent=2))


async def list_sources() -> list[dict]:
    async with _lock:
        return _read_manifest()


async def get_source(source_id: str) -> dict | None:
    entries = await list_sources()
    return next((e for e in entries if e["id"] == source_id), None)


async def delete_source(source_id: str) -> bool:
    async with _lock:
        entries = _read_manifest()
        remaining = [e for e in entries if e["id"] != source_id]
        if len(remaining) == len(entries):
            return False
        _write_manifest(remaining)
        removed = next(e for e in entries if e["id"] == source_id)
        db_path = SOURCES_DIR / removed["filename"]
        db_path.unlink(missing_ok=True)
        return True


async def _register(name: str, kind: str, origin: str, tmp_path: Path) -> dict:
    """Validate a downloaded/uploaded db file, then move it into the
    sources directory and add it to the manifest."""
    try:
        validate_schema(tmp_path)
    except SchemaError:
        tmp_path.unlink(missing_ok=True)
        raise

    source_id = uuid.uuid4().hex[:12]
    filename = f"{source_id}.db"
    final_path = SOURCES_DIR / filename
    tmp_path.rename(final_path)

    entry = {
        "id": source_id,
        "name": name,
        "kind": kind,       # "upload" | "remote"
        "origin": origin,   # original filename or URL
        "filename": filename,
        "added_at": time.time(),
    }
    async with _lock:
        entries = _read_manifest()
        entries.append(entry)
        _write_manifest(entries)
    return entry


async def add_upload(name: str, contents: bytes) -> dict:
    _ensure_dirs()
    tmp_path = SOURCES_DIR / f"tmp-{uuid.uuid4().hex}.db"
    tmp_path.write_bytes(contents)
    return await _register(name=name, kind="upload", origin=name, tmp_path=tmp_path)


def _assert_public_host(hostname: str) -> None:
    """Resolve hostname and reject anything pointing at loopback,
    link-local, private, or reserved address space (basic SSRF guard)."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise RemoteFetchError(f"Could not resolve host: {e}")

    if _allow_private_sources():
        return

    allowed_networks = _allowed_private_networks()

    for info in infos:
        addr = info[4][0]
        ip = ipaddress.ip_address(addr)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            if any(ip in net for net in allowed_networks):
                continue
            raise RemoteFetchError(f"Refusing to fetch from non-public address ({addr})")


def _validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise RemoteFetchError("Only http:// and https:// URLs are supported")
    if not parsed.hostname:
        raise RemoteFetchError("URL has no hostname")
    _assert_public_host(parsed.hostname)
    return parsed.hostname


async def add_remote(url: str) -> dict:
    _ensure_dirs()
    _validate_url(url)

    tmp_path = SOURCES_DIR / f"tmp-{uuid.uuid4().hex}.db"
    total = 0
    current_url = url
    max_redirects = 5
    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=REMOTE_TIMEOUT_SECONDS) as client:
            for _ in range(max_redirects + 1):
                async with client.stream("GET", current_url) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        location = resp.headers.get("location")
                        if not location:
                            raise RemoteFetchError("Redirect with no Location header")
                        current_url = httpx.URL(current_url).join(location).human_repr()
                        _validate_url(current_url)
                        continue
                    if resp.status_code >= 400:
                        raise RemoteFetchError(f"Remote returned HTTP {resp.status_code}")
                    with open(tmp_path, "wb") as f:
                        async for chunk in resp.aiter_bytes(chunk_size=65536):
                            total += len(chunk)
                            if total > MAX_REMOTE_BYTES:
                                raise RemoteFetchError(
                                    f"Remote file exceeds the {MAX_REMOTE_BYTES // (1024*1024)}MB limit"
                                )
                            f.write(chunk)
                    break
            else:
                raise RemoteFetchError("Too many redirects")
    except httpx.HTTPError as e:
        tmp_path.unlink(missing_ok=True)
        raise RemoteFetchError(f"Fetch failed: {e}")
    except RemoteFetchError:
        tmp_path.unlink(missing_ok=True)
        raise

    parsed = urlparse(current_url)
    name = parsed.path.rsplit("/", 1)[-1] or parsed.hostname
    try:
        return await _register(name=name, kind="remote", origin=url, tmp_path=tmp_path)
    except SchemaError as e:
        raise RemoteFetchError(str(e))


def source_db_path(entry: dict) -> Path:
    return SOURCES_DIR / entry["filename"]
