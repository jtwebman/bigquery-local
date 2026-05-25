"""
Python-client partitioning + clustering coverage:
  - Ingestion-time partitioning + _PARTITIONTIME / _PARTITIONDATE
  - Column partitioning
  - Clustering metadata
"""

from __future__ import annotations

from google.cloud import bigquery
from google.cloud.bigquery import (
    DatasetReference,
    SchemaField,
    Table,
    TableReference,
    TimePartitioning,
    TimePartitioningType,
)


def test_ingestion_time_partitioning(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.events")
    table = Table(table_ref, schema=[SchemaField("kind", "STRING")])
    table.time_partitioning = TimePartitioning(type_=TimePartitioningType.DAY)
    bq.create_table(table)

    bq.insert_rows_json(
        table_ref, [{"kind": "click"}, {"kind": "view"}]
    )

    # _PARTITIONTIME is the hidden column populated by the emulator.
    rows = list(
        bq.query(
            f"SELECT kind, _PARTITIONTIME IS NOT NULL AS has_ts "
            f"FROM `{project_id}.ds.events` ORDER BY kind"
        ).result()
    )
    assert all(r["has_ts"] for r in rows)


def test_partitiondate_filter_today(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.events")
    table = Table(table_ref, schema=[SchemaField("kind", "STRING")])
    table.time_partitioning = TimePartitioning(type_=TimePartitioningType.DAY)
    bq.create_table(table)
    bq.insert_rows_json(table_ref, [{"kind": "a"}, {"kind": "b"}])
    # Filter to today's partition — rows just inserted match.
    n = list(
        bq.query(
            f"SELECT count(*)::INT64 AS n FROM `{project_id}.ds.events` "
            "WHERE _PARTITIONDATE = CURRENT_DATE()"
        ).result()
    )[0]["n"]
    assert n == 2


def test_column_partitioning_metadata_round_trip(
    bq: bigquery.Client, project_id: str
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.orders")
    table = Table(
        table_ref,
        schema=[
            SchemaField("id", "INT64"),
            SchemaField("order_date", "DATE"),
            SchemaField("amount", "FLOAT64"),
        ],
    )
    table.time_partitioning = TimePartitioning(
        type_=TimePartitioningType.DAY, field="order_date"
    )
    bq.create_table(table)
    fetched = bq.get_table(table_ref)
    assert fetched.time_partitioning is not None
    assert fetched.time_partitioning.type_ == TimePartitioningType.DAY
    assert fetched.time_partitioning.field == "order_date"


def test_clustering_metadata_round_trip(
    bq: bigquery.Client, project_id: str
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.sessions")
    table = Table(
        table_ref,
        schema=[
            SchemaField("user_id", "STRING"),
            SchemaField("session_id", "STRING"),
            SchemaField("started_at", "TIMESTAMP"),
        ],
    )
    table.clustering_fields = ["user_id", "session_id"]
    bq.create_table(table)
    fetched = bq.get_table(table_ref)
    assert fetched.clustering_fields == ["user_id", "session_id"]


def test_is_partitioning_column_via_information_schema(
    bq: bigquery.Client, project_id: str
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.orders")
    table = Table(
        table_ref,
        schema=[
            SchemaField("id", "INT64"),
            SchemaField("order_date", "DATE"),
        ],
    )
    table.time_partitioning = TimePartitioning(
        type_=TimePartitioningType.DAY, field="order_date"
    )
    bq.create_table(table)
    rows = list(
        bq.query(
            f"SELECT column_name, is_partitioning_column "
            f"FROM `{project_id}.ds`.INFORMATION_SCHEMA.COLUMNS "
            "WHERE table_name = 'orders' ORDER BY ordinal_position"
        ).result()
    )
    by_name = {r["column_name"]: r["is_partitioning_column"] for r in rows}
    assert by_name == {"id": "NO", "order_date": "YES"}
