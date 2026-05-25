"""
Pytest fixtures for the Python client tests.

Session-scoped fixtures:
  - `gcs_stub` — a tiny Python `http.server` mimicking the subset of the
    GCS JSON API the emulator's load + extract paths use. Bound to a
    free port; exposes seed/read helpers for tests.
  - `emulator` — spawns `src/cli.ts` with `STORAGE_EMULATOR_HOST` pointed
    at the GCS stub so load / extract jobs round-trip through it.

Function-scoped fixtures:
  - `project_id` — unique per-test so tests don't collide on dataset
    names in the shared session-scoped emulator.
  - `bq` — a `BigQuery` client configured to use the emulator URL +
    `AnonymousCredentials` (the README's recommended OAuth-skip
    workaround).
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Iterator, Tuple
from urllib.parse import parse_qs, unquote, urlparse

import pytest
from google.auth.credentials import AnonymousCredentials
from google.cloud import bigquery

REPO_ROOT = Path(__file__).resolve().parents[3]


def _free_port() -> int:
    """Bind to port 0 to ask the kernel for a free port, then release."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# GCS stub
# ---------------------------------------------------------------------------


@dataclass
class _StoredObject:
    bytes: bytes
    content_type: str


@dataclass
class GcsStub:
    """Handle to a running in-process GCS stub. `objects` is keyed by
    `f"{bucket}::{name}"` so tests can seed (write into the dict) and
    observe (read back) artifacts created by extract jobs."""

    url: str
    objects: Dict[str, _StoredObject] = field(default_factory=dict)

    def put(self, bucket: str, name: str, body: bytes, content_type: str) -> None:
        self.objects[f"{bucket}::{name}"] = _StoredObject(body, content_type)

    def get(self, bucket: str, name: str) -> _StoredObject:
        return self.objects[f"{bucket}::{name}"]


def _make_gcs_handler(objects: Dict[str, _StoredObject]) -> type:
    """Build the HTTP handler class with a closure over the shared
    objects map. Mirrors test/api/parquet-load-extract.test.ts's
    Node stub — same shapes, same routes."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return  # silence access logs

        def _send_json(self, code: int, body: object) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _send_bytes(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            match = re.match(
                r"^/storage/v1/b/([^/]+)/o/(.+)$", parsed.path
            )
            if match is None:
                self.send_response(404)
                self.end_headers()
                return
            bucket, encoded = match.group(1), match.group(2)
            obj_name = unquote(encoded)
            stored = objects.get(f"{bucket}::{obj_name}")
            if stored is None:
                self._send_json(404, {"error": {"code": 404}})
                return
            qs = parse_qs(parsed.query)
            alt = (qs.get("alt", ["json"]) or ["json"])[0]
            if alt == "json":
                self._send_json(
                    200,
                    {
                        "name": obj_name,
                        "bucket": bucket,
                        "size": str(len(stored.bytes)),
                        "contentType": stored.content_type,
                        "updated": "2026-05-25T00:00:00.000Z",
                    },
                )
            else:
                self._send_bytes(200, stored.bytes, stored.content_type)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if not parsed.path.startswith("/upload/storage/v1/b/"):
                self.send_response(404)
                self.end_headers()
                return
            bucket_match = re.match(
                r"^/upload/storage/v1/b/([^/]+)/o$", parsed.path
            )
            if bucket_match is None:
                self.send_response(404)
                self.end_headers()
                return
            bucket = bucket_match.group(1)
            qs = parse_qs(parsed.query)
            name = (qs.get("name") or [None])[0]
            if name is None:
                self.send_response(400)
                self.end_headers()
                return
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length > 0 else b""
            content_type = self.headers.get("content-type") or "application/octet-stream"
            objects[f"{bucket}::{name}"] = _StoredObject(body, content_type)
            self._send_json(200, {"name": name, "bucket": bucket, "size": str(len(body))})

    return Handler


@pytest.fixture(scope="session")
def gcs_stub() -> Iterator[GcsStub]:
    port = _free_port()
    objects: Dict[str, _StoredObject] = {}
    server = ThreadingHTTPServer(("127.0.0.1", port), _make_gcs_handler(objects))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield GcsStub(url=f"http://127.0.0.1:{port}", objects=objects)
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------------------
# Emulator subprocess (configured to use the GCS stub)
# ---------------------------------------------------------------------------


def _wait_for_url(proc: subprocess.Popen[str], timeout_s: float = 30.0) -> str:
    pattern = re.compile(r"listening on (http://[^\s]+)")
    deadline = time.monotonic() + timeout_s
    assert proc.stdout is not None
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("emulator exited before listening")
            time.sleep(0.05)
            continue
        match = pattern.search(line)
        if match is not None:
            return match.group(1)
    raise TimeoutError("emulator did not print a listening URL within timeout")


@pytest.fixture(scope="session")
def emulator(gcs_stub: GcsStub) -> Iterator[str]:
    rest_port = _free_port()
    grpc_port = _free_port()
    cmd = [
        "node",
        "--conditions=src",
        "src/cli.ts",
        f"--port={rest_port}",
        f"--grpc-port={grpc_port}",
        "--database=:memory:",
    ]
    # Inherit the parent environment but point the load/extract paths
    # at the local GCS stub. This is the same env var Node + Python +
    # Go clients all honor.
    env = {**os.environ, "STORAGE_EMULATOR_HOST": gcs_stub.url}
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    try:
        url = _wait_for_url(proc)
        yield url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# ---------------------------------------------------------------------------
# Client + project
# ---------------------------------------------------------------------------


@pytest.fixture()
def project_id() -> str:
    return f"py-test-{uuid.uuid4().hex[:8]}"


@pytest.fixture()
def bq(emulator: str, project_id: str) -> bigquery.Client:
    return bigquery.Client(
        project=project_id,
        client_options={"api_endpoint": emulator},
        credentials=AnonymousCredentials(),
    )
