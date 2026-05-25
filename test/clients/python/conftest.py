"""
Pytest fixtures for the Python client tests.

`emulator` is a session-scoped fixture: it spawns `bin/bigquery-local.ts`
on a random free port (`--port=0`), parses the listening URL out of
stdout, and yields it. The emulator is torn down at session end.

`bq` is a function-scoped fixture: a fresh `BigQuery` client configured
to talk to the emulator. Uses `AnonymousCredentials` so the client
library doesn't try to fetch real OAuth tokens — same workaround the
README recommends (the env-var path with fake creds is the
client-library-style alternative).

Each test gets a unique project id so per-test datasets don't collide
when tests run in parallel.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import time
import uuid
from pathlib import Path
from typing import Iterator

import pytest
from google.auth.credentials import AnonymousCredentials
from google.cloud import bigquery

REPO_ROOT = Path(__file__).resolve().parents[3]


def _wait_for_url(proc: subprocess.Popen[str], timeout_s: float = 30.0) -> str:
    """Read the emulator's startup banner until we find the URL it printed.

    Banner format (from src/cli.ts):
      bigquery-local <version> listening on http://127.0.0.1:<port> ...
    """
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


def _free_port() -> int:
    """Bind to port 0 to ask the kernel for a free port, then release."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def emulator() -> Iterator[str]:
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
    proc = subprocess.Popen(
        cmd,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
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


@pytest.fixture()
def project_id() -> str:
    # Per-test isolation: each function gets a fresh project so the
    # session-scoped emulator can host all tests without dataset collisions.
    return f"py-test-{uuid.uuid4().hex[:8]}"


@pytest.fixture()
def bq(emulator: str, project_id: str) -> bigquery.Client:
    return bigquery.Client(
        project=project_id,
        client_options={"api_endpoint": emulator},
        credentials=AnonymousCredentials(),
    )
