// Routine + view lifecycle:
//   - SQL UDFs (CREATE FUNCTION, call, list via routines REST)
//   - Procedures with IN-params used inside INSERT bodies
//   - Procedures whose body is a SELECT — rows propagate to CALL
//   - Views
//   - Materialized views + CALL BQ.REFRESH_MATERIALIZED_VIEW
package bqlocal_test

import (
	"context"
	"testing"

	"cloud.google.com/go/bigquery"
	"google.golang.org/api/iterator"
)

func seedDataset(t *testing.T, client *bigquery.Client) {
	t.Helper()
	if err := client.Dataset("ds").Create(context.Background(), &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("create dataset: %v", err)
	}
}

func TestSQLUDFRoundTrip(t *testing.T) {
	client, project := newClient(t)
	seedDataset(t, client)
	if _, err := readAll(t, client.Query(
		"CREATE FUNCTION `"+project+".ds.double`(x INT64) RETURNS INT64 AS (x * 2)")); err != nil {
		t.Fatalf("create udf: %v", err)
	}
	rows, err := readAll(t, client.Query("SELECT `"+project+".ds.double`(21) AS n"))
	if err != nil {
		t.Fatalf("call udf: %v", err)
	}
	if rows[0][0].(int64) != 42 {
		t.Errorf("double(21) = %v, want 42", rows[0][0])
	}
}

func TestProcedureWithInParamInInsertBody(t *testing.T) {
	ctx := context.Background()
	client, project := newClient(t)
	seedDataset(t, client)
	table := client.Dataset("ds").Table("audit")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "name", Type: bigquery.StringFieldType},
			{Name: "ts", Type: bigquery.TimestampFieldType},
		},
	}); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := readAll(t, client.Query(`
		CREATE PROCEDURE `+"`"+project+".ds.record_visit`"+`(IN name STRING)
		BEGIN
		  INSERT INTO `+"`"+project+".ds.audit`"+` (name, ts) VALUES (name, CURRENT_TIMESTAMP());
		END;
	`)); err != nil {
		t.Fatalf("create procedure: %v", err)
	}
	for _, n := range []string{"alice", "bob"} {
		if _, err := readAll(t, client.Query(
			"CALL `"+project+".ds.record_visit`('"+n+"')")); err != nil {
			t.Fatalf("call %s: %v", n, err)
		}
	}
	rows, _ := readAll(t, client.Query(
		"SELECT name FROM `"+project+".ds.audit` ORDER BY name"))
	if len(rows) != 2 || rows[0][0].(string) != "alice" || rows[1][0].(string) != "bob" {
		t.Errorf("audit rows = %v, want [alice bob]", rows)
	}
}

func TestProcedureReturningSelectSurfacesRows(t *testing.T) {
	client, project := newClient(t)
	seedDataset(t, client)
	if _, err := readAll(t, client.Query(`
		CREATE PROCEDURE `+"`"+project+".ds.greet`"+`(IN who STRING)
		BEGIN
		  SELECT CONCAT('hi ', who) AS message;
		END;
	`)); err != nil {
		t.Fatalf("create procedure: %v", err)
	}
	rows, err := readAll(t, client.Query("CALL `"+project+".ds.greet`('alice')"))
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("CALL returned no rows (BL-procedure SELECT body fix)")
	}
	if rows[0][0].(string) != "hi alice" {
		t.Errorf("message = %v, want hi alice", rows[0][0])
	}
}

func TestViewLifecycle(t *testing.T) {
	ctx := context.Background()
	client, project := newClient(t)
	seedDataset(t, client)
	table := client.Dataset("ds").Table("orders")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "region", Type: bigquery.StringFieldType},
			{Name: "amount", Type: bigquery.IntegerFieldType},
		},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	type regionAmt struct {
		Region string `bigquery:"region"`
		Amount int64  `bigquery:"amount"`
	}
	if err := table.Inserter().Put(ctx, []*regionAmt{
		{Region: "east", Amount: 10},
		{Region: "east", Amount: 20},
		{Region: "west", Amount: 30},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if _, err := readAll(t, client.Query(
		"CREATE VIEW `"+project+".ds.east_orders` AS "+
			"SELECT region, amount FROM `"+project+".ds.orders` WHERE region = 'east'")); err != nil {
		t.Fatalf("create view: %v", err)
	}
	rows, _ := readAll(t, client.Query(
		"SELECT count(*)::INT64 AS n FROM `"+project+".ds.east_orders`"))
	if rows[0][0].(int64) != 2 {
		t.Errorf("view count = %v, want 2", rows[0][0])
	}
}

func TestMaterializedViewCreateAndRefresh(t *testing.T) {
	ctx := context.Background()
	client, project := newClient(t)
	seedDataset(t, client)
	table := client.Dataset("ds").Table("orders")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "region", Type: bigquery.StringFieldType},
			{Name: "amount", Type: bigquery.IntegerFieldType},
		},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	type regionAmt struct {
		Region string `bigquery:"region"`
		Amount int64  `bigquery:"amount"`
	}
	if err := table.Inserter().Put(ctx, []*regionAmt{
		{Region: "east", Amount: 1},
		{Region: "east", Amount: 2},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if _, err := readAll(t, client.Query(
		"CREATE MATERIALIZED VIEW `"+project+".ds.east_total` AS "+
			"SELECT SUM(amount) AS total FROM `"+project+".ds.orders` WHERE region = 'east'")); err != nil {
		t.Fatalf("create mv: %v", err)
	}
	before, _ := readAll(t, client.Query("SELECT total FROM `"+project+".ds.east_total`"))
	if before[0][0].(int64) != 3 {
		t.Errorf("snapshot total = %v, want 3", before[0][0])
	}
	// Add a row — MV is stale.
	if err := table.Inserter().Put(ctx, []*regionAmt{{Region: "east", Amount: 10}}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	stale, _ := readAll(t, client.Query("SELECT total FROM `"+project+".ds.east_total`"))
	if stale[0][0].(int64) != 3 {
		t.Errorf("stale total = %v, want still 3", stale[0][0])
	}
	// Refresh.
	if _, err := readAll(t, client.Query(
		"CALL BQ.REFRESH_MATERIALIZED_VIEW('" + project + ".ds.east_total')")); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	refreshed, _ := readAll(t, client.Query("SELECT total FROM `"+project+".ds.east_total`"))
	if refreshed[0][0].(int64) != 13 {
		t.Errorf("refreshed total = %v, want 13", refreshed[0][0])
	}
}

func TestRoutinesRestGetAndList(t *testing.T) {
	ctx := context.Background()
	client, project := newClient(t)
	seedDataset(t, client)
	if _, err := readAll(t, client.Query(
		"CREATE FUNCTION `"+project+".ds.tripler`(x INT64) RETURNS INT64 AS (x * 3)")); err != nil {
		t.Fatalf("create fn: %v", err)
	}
	it := client.Dataset("ds").Routines(ctx)
	var names []string
	for {
		r, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			t.Fatalf("routines list: %v", err)
		}
		names = append(names, r.RoutineID)
	}
	if len(names) != 1 || names[0] != "tripler" {
		t.Errorf("routines = %v, want [tripler]", names)
	}
	fetched, err := client.Dataset("ds").Routine("tripler").Metadata(ctx)
	if err != nil {
		t.Fatalf("get routine: %v", err)
	}
	if fetched.Body != "x * 3" {
		t.Errorf("body = %q, want %q", fetched.Body, "x * 3")
	}
}
