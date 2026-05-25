"""
Python-client routine + view lifecycle coverage:
  - SQL UDFs (CREATE FUNCTION, call, list via REST routines API)
  - Procedures (CREATE PROCEDURE, CALL)
  - Views (CREATE VIEW, query)
  - Materialized views (CREATE, query, CALL BQ.REFRESH_MATERIALIZED_VIEW)
"""

from __future__ import annotations

from google.cloud import bigquery
from google.cloud.bigquery import DatasetReference, SchemaField, Table, TableReference


def _seed_dataset(bq: bigquery.Client, project_id: str) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))


def test_sql_udf_round_trip(bq: bigquery.Client, project_id: str) -> None:
    _seed_dataset(bq, project_id)
    bq.query(
        f"CREATE FUNCTION `{project_id}.ds.double`(x INT64) RETURNS INT64 AS (x * 2)"
    ).result()
    row = list(
        bq.query(f"SELECT `{project_id}.ds.double`(21) AS n").result()
    )[0]
    assert row["n"] == 42


def test_procedure_with_in_param_in_insert_body(
    bq: bigquery.Client, project_id: str
) -> None:
    _seed_dataset(bq, project_id)
    # Procedure body uses the IN-param `name` inside an INSERT VALUES
    # clause. The script interpreter substitutes the param value as a
    # bound placeholder, but does NOT substitute the same identifier
    # when it appears in the INSERT column-list position — verified
    # below by using `name` as both column name and value reference.
    table_ref = TableReference.from_string(f"{project_id}.ds.audit")
    bq.create_table(
        Table(
            table_ref,
            schema=[SchemaField("name", "STRING"), SchemaField("ts", "TIMESTAMP")],
        )
    )
    bq.query(
        f"""
        CREATE PROCEDURE `{project_id}.ds.record_visit`(IN name STRING)
        BEGIN
          INSERT INTO `{project_id}.ds.audit` (name, ts) VALUES (name, CURRENT_TIMESTAMP());
        END;
        """
    ).result()
    bq.query(f"CALL `{project_id}.ds.record_visit`('alice')").result()
    bq.query(f"CALL `{project_id}.ds.record_visit`('bob')").result()
    rows = sorted(
        r["name"]
        for r in bq.query(
            f"SELECT name FROM `{project_id}.ds.audit` ORDER BY name"
        ).result()
    )
    assert rows == ["alice", "bob"]


def test_procedure_returning_select_surfaces_rows(
    bq: bigquery.Client, project_id: str
) -> None:
    _seed_dataset(bq, project_id)
    bq.query(
        f"""
        CREATE PROCEDURE `{project_id}.ds.greet`(IN who STRING)
        BEGIN
          SELECT CONCAT('hi ', who) AS message;
        END;
        """
    ).result()
    rows = list(bq.query(f"CALL `{project_id}.ds.greet`('alice')").result())
    assert rows[0]["message"] == "hi alice"


def test_view_lifecycle(bq: bigquery.Client, project_id: str) -> None:
    _seed_dataset(bq, project_id)
    table_ref = TableReference.from_string(f"{project_id}.ds.orders")
    bq.create_table(
        Table(
            table_ref,
            schema=[SchemaField("region", "STRING"), SchemaField("amount", "INT64")],
        )
    )
    bq.insert_rows_json(
        table_ref,
        [
            {"region": "east", "amount": 10},
            {"region": "east", "amount": 20},
            {"region": "west", "amount": 30},
        ],
    )
    bq.query(
        f"CREATE VIEW `{project_id}.ds.east_orders` AS "
        f"SELECT region, amount FROM `{project_id}.ds.orders` WHERE region = 'east'"
    ).result()
    rows = list(
        bq.query(
            f"SELECT count(*)::INT64 AS n FROM `{project_id}.ds.east_orders`"
        ).result()
    )
    assert rows[0]["n"] == 2


def test_materialized_view_create_and_refresh(
    bq: bigquery.Client, project_id: str
) -> None:
    _seed_dataset(bq, project_id)
    table_ref = TableReference.from_string(f"{project_id}.ds.orders")
    bq.create_table(
        Table(
            table_ref,
            schema=[SchemaField("region", "STRING"), SchemaField("amount", "INT64")],
        )
    )
    bq.insert_rows_json(
        table_ref,
        [{"region": "east", "amount": 1}, {"region": "east", "amount": 2}],
    )
    bq.query(
        f"CREATE MATERIALIZED VIEW `{project_id}.ds.east_total` AS "
        f"SELECT SUM(amount) AS total FROM `{project_id}.ds.orders` WHERE region = 'east'"
    ).result()
    # Snapshot reads 3.
    before = list(bq.query(f"SELECT total FROM `{project_id}.ds.east_total`").result())[0]
    assert before["total"] == 3
    # Add a row; MV is stale.
    bq.insert_rows_json(table_ref, [{"region": "east", "amount": 10}])
    stale = list(bq.query(f"SELECT total FROM `{project_id}.ds.east_total`").result())[0]
    assert stale["total"] == 3
    # Refresh.
    bq.query(
        f"CALL BQ.REFRESH_MATERIALIZED_VIEW('{project_id}.ds.east_total')"
    ).result()
    refreshed = list(
        bq.query(f"SELECT total FROM `{project_id}.ds.east_total`").result()
    )[0]
    assert refreshed["total"] == 13


def test_routines_rest_get_and_list(bq: bigquery.Client, project_id: str) -> None:
    _seed_dataset(bq, project_id)
    bq.query(
        f"CREATE FUNCTION `{project_id}.ds.tripler`(x INT64) RETURNS INT64 AS (x * 3)"
    ).result()
    routines = list(bq.list_routines(f"{project_id}.ds"))
    assert [r.routine_id for r in routines] == ["tripler"]
    fetched = bq.get_routine(f"{project_id}.ds.tripler")
    assert fetched.body == "x * 3"
