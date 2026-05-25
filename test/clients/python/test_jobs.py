"""
Python-client coverage for load, extract, and copy jobs.

The session-scoped GCS stub (see conftest.py) backs every URI; the
emulator was spawned with STORAGE_EMULATOR_HOST pointed at it, so
`configuration.load.sourceUris=['gs://...']` and
`configuration.extract.destinationUris=['gs://...']` round-trip through
the stub.

Covers:
  - BL-083 Load CSV with autodetect + explicit schema
  - BL-084 Load NEWLINE_DELIMITED_JSON with autodetect
  - BL-085 Load Parquet with autodetect
  - BL-090 Schema autodetect type inference
  - BL-094 Extract to CSV + NDJSON
  - BL-095 Copy table with WRITE_TRUNCATE
"""

from __future__ import annotations

import uuid

from google.cloud import bigquery
from google.cloud.bigquery import (
    CopyJobConfig,
    DatasetReference,
    ExtractJobConfig,
    LoadJobConfig,
    SchemaField,
    SourceFormat,
    Table,
    TableReference,
    WriteDisposition,
)


# ---------------------------------------------------------------------------
# Load: CSV
# ---------------------------------------------------------------------------


def test_load_csv_from_gcs_with_autodetect(
    bq: bigquery.Client, project_id: str, gcs_stub  # noqa: ANN001 (pytest fixture)
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    bucket = f"py-load-{uuid.uuid4().hex[:8]}"
    gcs_stub.put(
        bucket,
        "orders.csv",
        b"order_id,customer,amount,delivered\n"
        b"1,Alice,9.99,true\n"
        b"2,Bob,12.50,false\n"
        b"3,Charlie,7.00,true\n",
        "text/csv",
    )
    config = LoadJobConfig(
        source_format=SourceFormat.CSV,
        autodetect=True,
    )
    job = bq.load_table_from_uri(
        f"gs://{bucket}/orders.csv",
        f"{project_id}.ds.orders",
        job_config=config,
    )
    job.result()

    rows = list(
        bq.query(f"SELECT count(*)::INT64 AS n FROM `{project_id}.ds.orders`").result()
    )
    assert rows[0]["n"] == 3


def test_load_csv_with_explicit_schema(
    bq: bigquery.Client, project_id: str, gcs_stub  # noqa: ANN001
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    bucket = f"py-load-{uuid.uuid4().hex[:8]}"
    gcs_stub.put(
        bucket,
        "notes.csv",
        b"id,note\n1,first\n2,second\n",
        "text/csv",
    )
    config = LoadJobConfig(
        source_format=SourceFormat.CSV,
        schema=[
            SchemaField("id", "STRING", mode="REQUIRED"),
            SchemaField("note", "STRING"),
        ],
        skip_leading_rows=1,
    )
    job = bq.load_table_from_uri(
        f"gs://{bucket}/notes.csv",
        f"{project_id}.ds.notes",
        job_config=config,
    )
    job.result()

    rows = list(
        bq.query(
            f"SELECT id, note FROM `{project_id}.ds.notes` ORDER BY id"
        ).result()
    )
    assert [(r["id"], r["note"]) for r in rows] == [("1", "first"), ("2", "second")]


# ---------------------------------------------------------------------------
# Load: NDJSON
# ---------------------------------------------------------------------------


def test_load_ndjson_from_gcs_with_autodetect(
    bq: bigquery.Client, project_id: str, gcs_stub  # noqa: ANN001
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    bucket = f"py-load-{uuid.uuid4().hex[:8]}"
    gcs_stub.put(
        bucket,
        "events.ndjson",
        b'{"id":1,"kind":"click"}\n{"id":2,"kind":"view"}\n',
        "application/x-ndjson",
    )
    config = LoadJobConfig(
        source_format=SourceFormat.NEWLINE_DELIMITED_JSON,
        autodetect=True,
    )
    bq.load_table_from_uri(
        f"gs://{bucket}/events.ndjson",
        f"{project_id}.ds.events",
        job_config=config,
    ).result()

    rows = list(
        bq.query(
            f"SELECT id, kind FROM `{project_id}.ds.events` ORDER BY id"
        ).result()
    )
    assert [(r["id"], r["kind"]) for r in rows] == [(1, "click"), (2, "view")]


# ---------------------------------------------------------------------------
# Load: Parquet
# ---------------------------------------------------------------------------


def test_load_parquet_from_gcs(
    bq: bigquery.Client, project_id: str, gcs_stub  # noqa: ANN001
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    # Use the emulator's own COPY ... TO ... (FORMAT PARQUET) to
    # produce real Parquet bytes, then upload them to the stub. This
    # mirrors the strategy test/api/parquet-load-extract.test.ts uses.
    bucket = f"py-load-{uuid.uuid4().hex[:8]}"
    src_dataset = f"{project_id}_src"
    bq.create_dataset(DatasetReference(project_id, src_dataset))
    table_ref = TableReference.from_string(f"{project_id}.{src_dataset}.fixture")
    bq.create_table(
        Table(
            table_ref,
            schema=[
                SchemaField("id", "INT64"),
                SchemaField("label", "STRING"),
            ],
        )
    )
    bq.insert_rows_json(
        table_ref,
        [{"id": 1, "label": "alpha"}, {"id": 2, "label": "beta"}],
    )
    # Round-trip through extract to materialize Parquet bytes into the stub.
    extract_config = ExtractJobConfig(destination_format="PARQUET")
    bq.extract_table(
        table_ref,
        f"gs://{bucket}/fixture.parquet",
        job_config=extract_config,
    ).result()

    # Now load the same Parquet back into a fresh table — proves load
    # works end-to-end through the Python client.
    load_config = LoadJobConfig(
        source_format=SourceFormat.PARQUET,
        autodetect=True,
    )
    bq.load_table_from_uri(
        f"gs://{bucket}/fixture.parquet",
        f"{project_id}.ds.from_parquet",
        job_config=load_config,
    ).result()

    rows = list(
        bq.query(
            f"SELECT id, label FROM `{project_id}.ds.from_parquet` ORDER BY id"
        ).result()
    )
    assert [(r["id"], r["label"]) for r in rows] == [(1, "alpha"), (2, "beta")]


# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------


def test_extract_csv_writes_header_and_rows(
    bq: bigquery.Client, project_id: str, gcs_stub  # noqa: ANN001
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.users")
    bq.create_table(
        Table(
            table_ref,
            schema=[SchemaField("id", "INT64"), SchemaField("name", "STRING")],
        )
    )
    bq.insert_rows_json(
        table_ref,
        [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}],
    )
    bucket = f"py-extract-{uuid.uuid4().hex[:8]}"
    bq.extract_table(
        table_ref,
        f"gs://{bucket}/users.csv",
        job_config=ExtractJobConfig(destination_format="CSV"),
    ).result()
    stored = gcs_stub.get(bucket, "users.csv")
    text = stored.bytes.decode("utf-8")
    lines = [line for line in text.split("\n") if line]
    assert lines[0] == "id,name"
    assert sorted(lines[1:]) == ["1,Alice", "2,Bob"]


def test_extract_ndjson_round_trip(
    bq: bigquery.Client, project_id: str, gcs_stub  # noqa: ANN001
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.events")
    bq.create_table(
        Table(
            table_ref,
            schema=[SchemaField("id", "INT64"), SchemaField("kind", "STRING")],
        )
    )
    bq.insert_rows_json(table_ref, [{"id": 7, "kind": "click"}])
    bucket = f"py-extract-{uuid.uuid4().hex[:8]}"
    bq.extract_table(
        table_ref,
        f"gs://{bucket}/events.ndjson",
        job_config=ExtractJobConfig(destination_format="NEWLINE_DELIMITED_JSON"),
    ).result()
    stored = gcs_stub.get(bucket, "events.ndjson")
    import json as _json

    parsed = [_json.loads(line) for line in stored.bytes.decode("utf-8").split("\n") if line]
    assert parsed == [{"id": "7", "kind": "click"}]


# ---------------------------------------------------------------------------
# Copy
# ---------------------------------------------------------------------------


def test_copy_table_round_trip(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    src_ref = TableReference.from_string(f"{project_id}.ds.source")
    dst_ref = TableReference.from_string(f"{project_id}.ds.dest")
    bq.create_table(
        Table(
            src_ref,
            schema=[SchemaField("id", "INT64"), SchemaField("label", "STRING")],
        )
    )
    bq.insert_rows_json(
        src_ref,
        [{"id": 1, "label": "one"}, {"id": 2, "label": "two"}],
    )
    bq.copy_table(src_ref, dst_ref).result()
    rows = list(
        bq.query(f"SELECT id, label FROM `{project_id}.ds.dest` ORDER BY id").result()
    )
    assert [(r["id"], r["label"]) for r in rows] == [(1, "one"), (2, "two")]


def test_copy_with_write_truncate_overwrites_destination(
    bq: bigquery.Client, project_id: str
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    src = TableReference.from_string(f"{project_id}.ds.src")
    dst = TableReference.from_string(f"{project_id}.ds.dst")
    bq.create_table(
        Table(src, schema=[SchemaField("v", "INT64")])
    )
    bq.create_table(
        Table(dst, schema=[SchemaField("v", "INT64")])
    )
    bq.insert_rows_json(src, [{"v": 1}, {"v": 2}, {"v": 3}])
    bq.insert_rows_json(dst, [{"v": 999}])
    config = CopyJobConfig(write_disposition=WriteDisposition.WRITE_TRUNCATE)
    bq.copy_table(src, dst, job_config=config).result()
    rows = sorted(
        r["v"]
        for r in bq.query(f"SELECT v FROM `{project_id}.ds.dst`").result()
    )
    assert rows == [1, 2, 3]
