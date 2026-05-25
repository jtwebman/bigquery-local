"""
Real `google-cloud-bigquery` Python client end-to-end smoke tests.

Each test exercises a path a real dbt / Airflow / data-science consumer
would hit, against the actual emulator binary. These are the tests that
catch wire-format bugs the Node-only `sql-client-roundtrip` test would
miss — Python's HTTP framing, JSON canonicalization, and retry shape
differ from Node's.
"""

from __future__ import annotations

from google.cloud import bigquery
from google.cloud.bigquery import (
    DatasetReference,
    QueryJobConfig,
    ScalarQueryParameter,
    SchemaField,
    Table,
    TableReference,
)


# ---------------------------------------------------------------------------
# Connectivity + discovery
# ---------------------------------------------------------------------------


def test_get_service_account(bq: bigquery.Client, project_id: str) -> None:
    # BL-073 — the official client calls this on first job submission.
    email = bq.get_service_account_email(project=project_id)
    assert email.endswith(".gserviceaccount.invalid"), f"got {email!r}"


def test_list_projects_initially_empty(bq: bigquery.Client) -> None:
    projects = list(bq.list_projects())
    # No datasets created yet → no projects.
    assert projects == []


# ---------------------------------------------------------------------------
# Dataset CRUD
# ---------------------------------------------------------------------------


def test_create_get_list_delete_dataset(bq: bigquery.Client, project_id: str) -> None:
    ref = DatasetReference(project_id, "py_ds")
    dataset = bigquery.Dataset(ref)
    dataset.description = "created by python client test"
    dataset.labels = {"owner": "py-test"}

    created = bq.create_dataset(dataset)
    assert created.dataset_id == "py_ds"
    assert created.description == "created by python client test"
    assert created.labels == {"owner": "py-test"}

    fetched = bq.get_dataset(ref)
    assert fetched.description == "created by python client test"

    listed = [ds.dataset_id for ds in bq.list_datasets(project_id)]
    assert listed == ["py_ds"]

    bq.delete_dataset(ref, delete_contents=True)
    assert [ds.dataset_id for ds in bq.list_datasets(project_id)] == []


# ---------------------------------------------------------------------------
# Table CRUD with schema
# ---------------------------------------------------------------------------


def test_create_table_and_insert_rows(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "py_ds"))
    table_ref = TableReference.from_string(f"{project_id}.py_ds.users")
    table = Table(
        table_ref,
        schema=[
            SchemaField("id", "INT64", mode="REQUIRED"),
            SchemaField("name", "STRING"),
            SchemaField("active", "BOOL"),
        ],
    )
    bq.create_table(table)

    errors = bq.insert_rows_json(
        table_ref,
        [
            {"id": 1, "name": "Alice", "active": True},
            {"id": 2, "name": "Bob", "active": False},
        ],
    )
    assert errors == [], f"unexpected insert errors: {errors}"

    rows = list(bq.list_rows(table_ref))
    assert len(rows) == 2
    by_id = {row["id"]: row for row in rows}
    assert by_id[1]["name"] == "Alice"
    assert by_id[1]["active"] is True
    assert by_id[2]["name"] == "Bob"
    assert by_id[2]["active"] is False


# ---------------------------------------------------------------------------
# Queries — simple + parameterized
# ---------------------------------------------------------------------------


def test_simple_query(bq: bigquery.Client) -> None:
    job = bq.query("SELECT 1 AS one, 'hi' AS greeting")
    rows = list(job.result())
    assert len(rows) == 1
    assert rows[0]["one"] == 1
    assert rows[0]["greeting"] == "hi"


def test_parameterized_query(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "py_ds"))
    table_ref = TableReference.from_string(f"{project_id}.py_ds.orders")
    bq.create_table(
        Table(
            table_ref,
            schema=[
                SchemaField("id", "INT64"),
                SchemaField("amount", "FLOAT64"),
            ],
        )
    )
    bq.insert_rows_json(
        table_ref,
        [
            {"id": 1, "amount": 9.99},
            {"id": 2, "amount": 12.50},
            {"id": 3, "amount": 100.00},
        ],
    )

    config = QueryJobConfig(
        query_parameters=[ScalarQueryParameter("threshold", "FLOAT64", 10.0)]
    )
    job = bq.query(
        f"SELECT id, amount FROM `{project_id}.py_ds.orders` "
        "WHERE amount > @threshold ORDER BY id",
        job_config=config,
    )
    rows = [(r["id"], r["amount"]) for r in job.result()]
    assert rows == [(2, 12.5), (3, 100.0)]


def test_query_cache_hit(bq: bigquery.Client) -> None:
    # BL-157 — second identical query reports cacheHit=true on the job.
    sql = "SELECT 42 AS the_answer"
    first = bq.query(sql)
    list(first.result())
    assert first.cache_hit is False, "first run should not hit cache"

    second = bq.query(sql)
    list(second.result())
    assert second.cache_hit is True, "second run should hit cache"


# ---------------------------------------------------------------------------
# INFORMATION_SCHEMA
# ---------------------------------------------------------------------------


def test_information_schema_tables(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "py_ds"))
    for name in ("a", "b", "c"):
        bq.create_table(
            Table(
                TableReference.from_string(f"{project_id}.py_ds.{name}"),
                schema=[SchemaField("x", "STRING")],
            )
        )
    job = bq.query(
        f"SELECT table_name FROM `{project_id}.py_ds`.INFORMATION_SCHEMA.TABLES "
        "ORDER BY table_name"
    )
    names = [r["table_name"] for r in job.result()]
    assert names == ["a", "b", "c"]


def test_information_schema_columns_reports_bq_types(
    bq: bigquery.Client, project_id: str
) -> None:
    bq.create_dataset(DatasetReference(project_id, "py_ds"))
    bq.create_table(
        Table(
            TableReference.from_string(f"{project_id}.py_ds.typed"),
            schema=[
                SchemaField("id", "INT64", mode="REQUIRED"),
                SchemaField("name", "STRING"),
                SchemaField("scores", "FLOAT64", mode="REPEATED"),
            ],
        )
    )
    job = bq.query(
        f"SELECT column_name, data_type, is_nullable "
        f"FROM `{project_id}.py_ds`.INFORMATION_SCHEMA.COLUMNS "
        f"WHERE table_name = 'typed' ORDER BY ordinal_position"
    )
    rows = [(r["column_name"], r["data_type"], r["is_nullable"]) for r in job.result()]
    assert rows == [
        ("id", "INT64", "NO"),
        ("name", "STRING", "YES"),
        ("scores", "ARRAY<FLOAT64>", "YES"),
    ]


# ---------------------------------------------------------------------------
# Errors surface as Python exceptions
# ---------------------------------------------------------------------------


def test_query_against_missing_table_raises(bq: bigquery.Client, project_id: str) -> None:
    import google.api_core.exceptions as gax

    bq.create_dataset(DatasetReference(project_id, "py_ds"))
    # The Python client raises synchronously from query() — the POST to
    # /jobs gets a 400 immediately. Catch around the query() call, not
    # around .result().
    try:
        bq.query(f"SELECT * FROM `{project_id}.py_ds.nope`")
    except gax.BadRequest:
        return  # expected
    raise AssertionError("expected a BadRequest for a missing table")
