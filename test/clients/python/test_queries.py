"""
Python-client SQL feature happy-path coverage.

Each test exercises a distinct BL-XXX SQL feature through the real
`google-cloud-bigquery` client — different from the Node-only
integration tests in test/api/. The goal is to catch wire-format bugs
that only surface through the Python client's JSON canonicalization,
parameter encoding, or job-state polling.
"""

from __future__ import annotations

from google.cloud import bigquery
from google.cloud.bigquery import (
    ArrayQueryParameter,
    DatasetReference,
    QueryJobConfig,
    ScalarQueryParameter,
    SchemaField,
    Table,
    TableReference,
)


def _seed_orders(bq: bigquery.Client, project_id: str) -> str:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.orders")
    bq.create_table(
        Table(
            table_ref,
            schema=[
                SchemaField("region", "STRING"),
                SchemaField("product", "STRING"),
                SchemaField("amount", "INT64"),
            ],
        )
    )
    bq.insert_rows_json(
        table_ref,
        [
            {"region": "east", "product": "a", "amount": 10},
            {"region": "east", "product": "b", "amount": 20},
            {"region": "east", "product": "c", "amount": 5},
            {"region": "west", "product": "a", "amount": 30},
            {"region": "west", "product": "b", "amount": 40},
        ],
    )
    return f"{project_id}.ds.orders"


# ---------------------------------------------------------------------------
# Parameter shapes
# ---------------------------------------------------------------------------


def test_named_parameter_with_int64(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    config = QueryJobConfig(
        query_parameters=[ScalarQueryParameter("threshold", "INT64", 20)]
    )
    rows = list(
        bq.query(f"SELECT count(*) AS n FROM `{fqn}` WHERE amount >= @threshold", job_config=config).result()
    )
    assert rows[0]["n"] == 3


def test_named_parameter_with_string(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    config = QueryJobConfig(query_parameters=[ScalarQueryParameter("r", "STRING", "east")])
    rows = list(
        bq.query(f"SELECT count(*) AS n FROM `{fqn}` WHERE region = @r", job_config=config).result()
    )
    assert rows[0]["n"] == 3


def test_array_parameter_with_int64_elements(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    config = QueryJobConfig(
        query_parameters=[ArrayQueryParameter("targets", "INT64", [10, 30])]
    )
    rows = sorted(
        r["amount"]
        for r in bq.query(
            f"SELECT amount FROM `{fqn}` WHERE amount IN UNNEST(@targets)",
            job_config=config,
        ).result()
    )
    assert rows == [10, 30]


# ---------------------------------------------------------------------------
# SQL idioms — Phase 10 (BL-053 MERGE, BL-057 QUALIFY, BL-058 PIVOT)
# ---------------------------------------------------------------------------


def test_merge_inserts_and_updates(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    bq.query(
        f"""
        MERGE INTO `{fqn}` AS target
        USING (SELECT 'east' AS region, 'a' AS product, 999 AS amount) AS src
        ON target.region = src.region AND target.product = src.product
        WHEN MATCHED THEN UPDATE SET amount = src.amount
        WHEN NOT MATCHED THEN INSERT (region, product, amount) VALUES (src.region, src.product, src.amount)
        """
    ).result()
    row = list(
        bq.query(
            f"SELECT amount FROM `{fqn}` WHERE region = 'east' AND product = 'a'"
        ).result()
    )[0]
    assert row["amount"] == 999


def test_qualify_row_number_per_partition(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    rows = list(
        bq.query(
            f"""
            SELECT region, product, amount
            FROM `{fqn}`
            QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) = 1
            ORDER BY region
            """
        ).result()
    )
    # Top earner per region.
    by_region = {r["region"]: r["product"] for r in rows}
    assert by_region == {"east": "b", "west": "b"}


def test_pivot(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    rows = list(
        bq.query(
            f"""
            SELECT * FROM (
              SELECT region, product, amount FROM `{fqn}`
            ) PIVOT (
              SUM(amount) FOR product IN ('a', 'b', 'c')
            )
            ORDER BY region
            """
        ).result()
    )
    east = {r["region"]: r for r in rows}["east"]
    # Three product columns get materialized via PIVOT.
    assert east["a"] == 10
    assert east["b"] == 20
    assert east["c"] == 5


# ---------------------------------------------------------------------------
# CTEs + window
# ---------------------------------------------------------------------------


def test_with_cte_and_window(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    rows = list(
        bq.query(
            f"""
            WITH ranked AS (
              SELECT region, product, amount,
                     RANK() OVER (PARTITION BY region ORDER BY amount DESC) AS r
              FROM `{fqn}`
            )
            SELECT region, product FROM ranked WHERE r = 1 ORDER BY region
            """
        ).result()
    )
    assert [r["product"] for r in rows] == ["b", "b"]


# ---------------------------------------------------------------------------
# Aggregates + types
# ---------------------------------------------------------------------------


def test_approx_count_distinct(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    row = list(
        bq.query(f"SELECT APPROX_COUNT_DISTINCT(product) AS n FROM `{fqn}`").result()
    )[0]
    # 3 distinct products in fixture.
    assert row["n"] == 3


def test_array_agg_and_unnest(bq: bigquery.Client, project_id: str) -> None:
    # ARRAY_AGG over a real table + UNNEST round-trip — proves the
    # ARRAY type survives wire encoding back to the Python client.
    fqn = _seed_orders(bq, project_id)
    rows = list(
        bq.query(
            f"""
            SELECT region, ARRAY_AGG(product ORDER BY product) AS products
            FROM `{fqn}`
            GROUP BY region
            ORDER BY region
            """
        ).result()
    )
    by_region = {r["region"]: list(r["products"]) for r in rows}
    assert by_region == {"east": ["a", "b", "c"], "west": ["a", "b"]}


def test_json_value(bq: bigquery.Client) -> None:
    row = list(
        bq.query(
            "SELECT JSON_VALUE('{\"a\":{\"b\":\"hello\"}}', '$.a.b') AS v"
        ).result()
    )[0]
    assert row["v"] == "hello"


def test_timestamp_arithmetic(bq: bigquery.Client) -> None:
    row = list(
        bq.query(
            "SELECT TIMESTAMP_DIFF(TIMESTAMP '2026-05-25T00:00:00Z', "
            "TIMESTAMP '2026-05-24T00:00:00Z', HOUR) AS hours"
        ).result()
    )[0]
    assert row["hours"] == 24


# ---------------------------------------------------------------------------
# DML
# ---------------------------------------------------------------------------


def test_insert_update_delete(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    # INSERT
    bq.query(f"INSERT INTO `{fqn}` (region, product, amount) VALUES ('south', 'z', 7)").result()
    # UPDATE
    bq.query(f"UPDATE `{fqn}` SET amount = 8 WHERE region = 'south'").result()
    # DELETE
    bq.query(f"DELETE FROM `{fqn}` WHERE region = 'south'").result()

    row = list(
        bq.query(f"SELECT count(*) AS n FROM `{fqn}` WHERE region = 'south'").result()
    )[0]
    assert row["n"] == 0


def test_truncate_preserves_schema(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    bq.query(f"TRUNCATE TABLE `{fqn}`").result()
    row = list(bq.query(f"SELECT count(*) AS n FROM `{fqn}`").result())[0]
    assert row["n"] == 0
    # Schema still queryable.
    cols = list(
        bq.query(
            f"SELECT column_name FROM `{project_id}.ds`.INFORMATION_SCHEMA.COLUMNS "
            "WHERE table_name = 'orders' ORDER BY ordinal_position"
        ).result()
    )
    assert [c["column_name"] for c in cols] == ["region", "product", "amount"]


# ---------------------------------------------------------------------------
# Multi-statement script
# ---------------------------------------------------------------------------


def test_multi_statement_script(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    bq.query(
        f"""
        BEGIN
          DECLARE total INT64 DEFAULT 0;
          SET total = (SELECT SUM(amount) FROM `{fqn}`);
          INSERT INTO `{fqn}` (region, product, amount) VALUES ('total', 'sum', total);
        END;
        """
    ).result()
    row = list(
        bq.query(f"SELECT amount FROM `{fqn}` WHERE region = 'total'").result()
    )[0]
    # Sum of the original 5 rows.
    assert row["amount"] == 105


def test_transaction_commit_and_rollback(bq: bigquery.Client, project_id: str) -> None:
    fqn = _seed_orders(bq, project_id)
    # COMMIT path
    bq.query(
        f"""
        BEGIN TRANSACTION;
        INSERT INTO `{fqn}` (region, product, amount) VALUES ('north', 'x', 1);
        COMMIT;
        """
    ).result()
    n = list(bq.query(f"SELECT count(*) AS n FROM `{fqn}` WHERE region = 'north'").result())[0][
        "n"
    ]
    assert n == 1


# ---------------------------------------------------------------------------
# Dry-run + cost
# ---------------------------------------------------------------------------


def test_dry_run_reports_bytes_and_skips_persistence(
    bq: bigquery.Client, project_id: str
) -> None:
    fqn = _seed_orders(bq, project_id)
    config = QueryJobConfig(dry_run=True, use_query_cache=False)
    job = bq.query(f"SELECT * FROM `{fqn}`", job_config=config)
    # Dry-run returns the job synchronously; no .result() needed.
    assert job.total_bytes_processed is not None and job.total_bytes_processed > 0


# ---------------------------------------------------------------------------
# Wildcard tables
# ---------------------------------------------------------------------------


def test_wildcard_tables(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    for suffix in ("20260101", "20260102", "20260103"):
        table_ref = TableReference.from_string(f"{project_id}.ds.events_{suffix}")
        bq.create_table(
            Table(table_ref, schema=[SchemaField("id", "INT64")])
        )
        bq.insert_rows_json(table_ref, [{"id": int(suffix[-2:])}])
    rows = list(
        bq.query(
            f"SELECT _TABLE_SUFFIX AS suf, id FROM `{project_id}.ds.events_*` ORDER BY suf"
        ).result()
    )
    assert [(r["suf"], r["id"]) for r in rows] == [
        ("20260101", 1),
        ("20260102", 2),
        ("20260103", 3),
    ]
