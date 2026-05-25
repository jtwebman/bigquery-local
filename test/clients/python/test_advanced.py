"""
Python-client coverage for advanced 1.0.0 features:
  - Labels propagation on tables + jobs (BL-154)
  - Locations metadata + cross-location enforcement (BL-155)
  - useQueryCache (BL-157)
  - Multi-project isolation
"""

from __future__ import annotations

from google.cloud import bigquery
from google.cloud.bigquery import (
    DatasetReference,
    QueryJobConfig,
    SchemaField,
    Table,
    TableReference,
)


# ---------------------------------------------------------------------------
# Labels (BL-154)
# ---------------------------------------------------------------------------


def test_table_labels_round_trip_via_create_and_patch(
    bq: bigquery.Client, project_id: str
) -> None:
    bq.create_dataset(DatasetReference(project_id, "ds"))
    table_ref = TableReference.from_string(f"{project_id}.ds.t")
    table = Table(table_ref, schema=[SchemaField("id", "INT64")])
    table.labels = {"team": "platform", "env": "test"}
    bq.create_table(table)
    fetched = bq.get_table(table_ref)
    assert fetched.labels == {"team": "platform", "env": "test"}

    # PATCH replaces.
    fetched.labels = {"team": "data"}
    updated = bq.update_table(fetched, ["labels"])
    assert updated.labels == {"team": "data"}


def test_job_labels_round_trip(bq: bigquery.Client) -> None:
    config = QueryJobConfig(labels={"owner": "py-test", "priority": "low"})
    job = bq.query("SELECT 1 AS one", job_config=config)
    list(job.result())
    # The Python client re-reads job state; verify labels survived
    # through storage.
    refreshed = bq.get_job(job.job_id)
    assert refreshed.labels == {"owner": "py-test", "priority": "low"}


# ---------------------------------------------------------------------------
# Locations (BL-155)
# ---------------------------------------------------------------------------


def test_dataset_location_round_trip(bq: bigquery.Client, project_id: str) -> None:
    ds = bigquery.Dataset(DatasetReference(project_id, "eu_ds"))
    ds.location = "EU"
    created = bq.create_dataset(ds)
    assert created.location == "EU"
    fetched = bq.get_dataset(created.reference)
    assert fetched.location == "EU"


# ---------------------------------------------------------------------------
# Query cache (BL-157)
# ---------------------------------------------------------------------------


def test_use_query_cache_default_hits_on_second_run(
    bq: bigquery.Client,
) -> None:
    # A SQL string that's specific to this test so it doesn't collide
    # with the cache from other tests sharing the session-scoped
    # emulator.
    sql = "SELECT 'py-cache' AS marker, 1 AS one"
    first = bq.query(sql)
    list(first.result())
    assert first.cache_hit is False

    second = bq.query(sql)
    list(second.result())
    assert second.cache_hit is True


def test_use_query_cache_false_bypasses(bq: bigquery.Client) -> None:
    sql = "SELECT 'py-cache-bypass' AS marker"
    # Prime the cache.
    list(bq.query(sql).result())
    # Bypass.
    config = QueryJobConfig(use_query_cache=False)
    bypassed = bq.query(sql, job_config=config)
    list(bypassed.result())
    assert bypassed.cache_hit is False


# ---------------------------------------------------------------------------
# Multi-project isolation
# ---------------------------------------------------------------------------


def test_two_projects_can_have_same_dataset_id(
    emulator: str, project_id: str
) -> None:
    # The session-scoped emulator hosts every project; demonstrate that
    # two distinct projects can each have a "ds" dataset without
    # collision (multi-tenant promise — projects scope-out at the URL
    # level).
    from google.auth.credentials import AnonymousCredentials

    creds = AnonymousCredentials()
    a = bigquery.Client(
        project=f"{project_id}-a",
        client_options={"api_endpoint": emulator},
        credentials=creds,
    )
    b = bigquery.Client(
        project=f"{project_id}-b",
        client_options={"api_endpoint": emulator},
        credentials=creds,
    )
    a.create_dataset(DatasetReference(f"{project_id}-a", "ds"))
    b.create_dataset(DatasetReference(f"{project_id}-b", "ds"))
    # Each project sees only its own.
    assert [d.dataset_id for d in a.list_datasets(f"{project_id}-a")] == ["ds"]
    assert [d.dataset_id for d in b.list_datasets(f"{project_id}-b")] == ["ds"]
