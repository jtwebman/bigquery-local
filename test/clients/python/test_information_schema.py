"""
Python-client INFORMATION_SCHEMA happy-path coverage.

Verifies the BQ Python client can introspect the emulator's metadata
through the standard INFORMATION_SCHEMA views (BL-075..079), via both
region-scoped and dataset-scoped reference forms.
"""

from __future__ import annotations

from google.cloud import bigquery
from google.cloud.bigquery import DatasetReference, SchemaField, Table, TableReference


def _seed(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    bq.create_table(
        Table(
            TableReference.from_string(f"{project_id}.ds.users"),
            schema=[
                SchemaField("id", "INT64", mode="REQUIRED"),
                SchemaField("name", "STRING"),
                SchemaField("tags", "STRING", mode="REPEATED"),
            ],
        )
    )
    bq.create_table(
        Table(
            TableReference.from_string(f"{project_id}.ds.orders"),
            schema=[
                SchemaField("order_id", "STRING"),
                SchemaField("amount", "FLOAT64"),
            ],
        )
    )


def test_info_schemata_lists_dataset(bq: bigquery.Client, project_id: str) -> None:
    _seed(bq, project_id)
    rows = list(
        bq.query(
            "SELECT catalog_name, schema_name, location "
            "FROM `region-us`.INFORMATION_SCHEMA.SCHEMATA"
        ).result()
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["catalog_name"] == project_id
    assert r["schema_name"] == "ds"


def test_info_tables_dataset_scoped(bq: bigquery.Client, project_id: str) -> None:
    _seed(bq, project_id)
    rows = list(
        bq.query(
            f"SELECT table_name, table_type FROM `{project_id}.ds`.INFORMATION_SCHEMA.TABLES "
            "ORDER BY table_name"
        ).result()
    )
    assert [(r["table_name"], r["table_type"]) for r in rows] == [
        ("orders", "BASE TABLE"),
        ("users", "BASE TABLE"),
    ]


def test_info_columns_struct_and_repeated(bq: bigquery.Client, project_id: str) -> None:
    _seed(bq, project_id)
    rows = list(
        bq.query(
            f"SELECT column_name, data_type, is_nullable "
            f"FROM `{project_id}.ds`.INFORMATION_SCHEMA.COLUMNS "
            "WHERE table_name = 'users' ORDER BY ordinal_position"
        ).result()
    )
    assert [(r["column_name"], r["data_type"], r["is_nullable"]) for r in rows] == [
        ("id", "INT64", "NO"),
        ("name", "STRING", "YES"),
        ("tags", "ARRAY<STRING>", "YES"),
    ]


def test_info_views(bq: bigquery.Client, project_id: str) -> None:
    _seed(bq, project_id)
    bq.query(
        f"CREATE VIEW `{project_id}.ds.recent_users` AS "
        f"SELECT id, name FROM `{project_id}.ds.users`"
    ).result()
    rows = list(
        bq.query(
            f"SELECT table_name, use_standard_sql "
            f"FROM `{project_id}.ds`.INFORMATION_SCHEMA.VIEWS ORDER BY table_name"
        ).result()
    )
    assert [(r["table_name"], r["use_standard_sql"]) for r in rows] == [
        ("recent_users", "YES"),
    ]


def test_info_routines_after_create_function(
    bq: bigquery.Client, project_id: str
) -> None:
    _seed(bq, project_id)
    bq.query(
        f"CREATE FUNCTION `{project_id}.ds.double_amount`(x INT64) "
        "RETURNS INT64 AS (x * 2)"
    ).result()
    rows = list(
        bq.query(
            f"SELECT routine_name, routine_type, data_type "
            f"FROM `{project_id}.ds`.INFORMATION_SCHEMA.ROUTINES"
        ).result()
    )
    assert len(rows) == 1
    assert rows[0]["routine_name"] == "double_amount"
    assert rows[0]["routine_type"] == "FUNCTION"
    assert rows[0]["data_type"] == "INT64"


def test_info_parameters(bq: bigquery.Client, project_id: str) -> None:
    _seed(bq, project_id)
    bq.query(
        f"CREATE FUNCTION `{project_id}.ds.add_two`(a INT64, b INT64) "
        "RETURNS INT64 AS (a + b)"
    ).result()
    rows = list(
        bq.query(
            f"SELECT parameter_name, parameter_mode, data_type "
            f"FROM `{project_id}.ds`.INFORMATION_SCHEMA.PARAMETERS "
            "WHERE specific_name = 'add_two' ORDER BY ordinal_position"
        ).result()
    )
    assert [(r["parameter_name"], r["parameter_mode"], r["data_type"]) for r in rows] == [
        ("a", "IN", "INT64"),
        ("b", "IN", "INT64"),
    ]


def test_info_jobs_after_query(bq: bigquery.Client, project_id: str) -> None:
    _seed(bq, project_id)
    # Run a few queries so JOBS has rows.
    for _ in range(3):
        list(bq.query("SELECT 1").result())
    rows = list(
        bq.query(
            "SELECT COUNT(*)::INT64 AS n "
            "FROM `region-us`.INFORMATION_SCHEMA.JOBS WHERE state = 'DONE'"
        ).result()
    )
    # At least the three SELECTs above ran (plus the SELECT COUNT itself).
    assert rows[0]["n"] >= 3
