// INFORMATION_SCHEMA happy-path coverage (BL-075..079) through the Go
// bigquery client. Verifies dataset- and region-scoped introspection
// views work for SCHEMATA, TABLES, COLUMNS, VIEWS, ROUTINES, PARAMETERS,
// JOBS.
package bqlocal_test

import (
	"context"
	"testing"

	"cloud.google.com/go/bigquery"
)

func seedInfoSchema(t *testing.T, client *bigquery.Client) {
	t.Helper()
	ctx := context.Background()
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	if err := client.Dataset("ds").Table("users").Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType, Required: true},
			{Name: "name", Type: bigquery.StringFieldType},
			{Name: "tags", Type: bigquery.StringFieldType, Repeated: true},
		},
	}); err != nil {
		t.Fatalf("create users: %v", err)
	}
	if err := client.Dataset("ds").Table("orders").Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "order_id", Type: bigquery.StringFieldType},
			{Name: "amount", Type: bigquery.FloatFieldType},
		},
	}); err != nil {
		t.Fatalf("create orders: %v", err)
	}
}

func TestInfoSchemataListsDataset(t *testing.T) {
	client, project := newClient(t)
	seedInfoSchema(t, client)
	rows, err := readAll(t, client.Query(
		"SELECT catalog_name, schema_name, location "+
			"FROM `region-us`.INFORMATION_SCHEMA.SCHEMATA"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if got := rows[0][0].(string); got != project {
		t.Errorf("catalog = %v, want %v", got, project)
	}
	if got := rows[0][1].(string); got != "ds" {
		t.Errorf("schema = %v, want ds", got)
	}
}

func TestInfoTablesDatasetScoped(t *testing.T) {
	client, project := newClient(t)
	seedInfoSchema(t, client)
	rows, err := readAll(t, client.Query(
		"SELECT table_name, table_type FROM `"+project+".ds`.INFORMATION_SCHEMA.TABLES "+
			"ORDER BY table_name"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	want := [][]string{{"orders", "BASE TABLE"}, {"users", "BASE TABLE"}}
	for i, w := range want {
		if rows[i][0].(string) != w[0] || rows[i][1].(string) != w[1] {
			t.Errorf("row[%d] = %v, want %v", i, rows[i], w)
		}
	}
}

func TestInfoColumnsStructAndRepeated(t *testing.T) {
	client, project := newClient(t)
	seedInfoSchema(t, client)
	rows, err := readAll(t, client.Query(
		"SELECT column_name, data_type, is_nullable "+
			"FROM `"+project+".ds`.INFORMATION_SCHEMA.COLUMNS "+
			"WHERE table_name = 'users' ORDER BY ordinal_position"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	want := [][]string{
		{"id", "INT64", "NO"},
		{"name", "STRING", "YES"},
		{"tags", "ARRAY<STRING>", "YES"},
	}
	for i, w := range want {
		for j, exp := range w {
			if got := rows[i][j].(string); got != exp {
				t.Errorf("row[%d][%d] = %v, want %v", i, j, got, exp)
			}
		}
	}
}

func TestInfoViews(t *testing.T) {
	client, project := newClient(t)
	seedInfoSchema(t, client)
	if _, err := readAll(t, client.Query(
		"CREATE VIEW `"+project+".ds.recent_users` AS "+
			"SELECT id, name FROM `"+project+".ds.users`")); err != nil {
		t.Fatalf("create view: %v", err)
	}
	rows, err := readAll(t, client.Query(
		"SELECT table_name, use_standard_sql "+
			"FROM `"+project+".ds`.INFORMATION_SCHEMA.VIEWS ORDER BY table_name"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if rows[0][0].(string) != "recent_users" || rows[0][1].(string) != "YES" {
		t.Errorf("VIEWS row = %v, want [recent_users YES]", rows[0])
	}
}

func TestInfoRoutinesAfterCreateFunction(t *testing.T) {
	client, project := newClient(t)
	seedInfoSchema(t, client)
	if _, err := readAll(t, client.Query(
		"CREATE FUNCTION `"+project+".ds.double_amount`(x INT64) "+
			"RETURNS INT64 AS (x * 2)")); err != nil {
		t.Fatalf("create fn: %v", err)
	}
	rows, err := readAll(t, client.Query(
		"SELECT routine_name, routine_type, data_type "+
			"FROM `"+project+".ds`.INFORMATION_SCHEMA.ROUTINES"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	got := rows[0]
	if got[0].(string) != "double_amount" || got[1].(string) != "FUNCTION" || got[2].(string) != "INT64" {
		t.Errorf("ROUTINES row = %v", got)
	}
}

func TestInfoParameters(t *testing.T) {
	client, project := newClient(t)
	seedInfoSchema(t, client)
	if _, err := readAll(t, client.Query(
		"CREATE FUNCTION `"+project+".ds.add_two`(a INT64, b INT64) "+
			"RETURNS INT64 AS (a + b)")); err != nil {
		t.Fatalf("create fn: %v", err)
	}
	rows, err := readAll(t, client.Query(
		"SELECT parameter_name, parameter_mode, data_type "+
			"FROM `"+project+".ds`.INFORMATION_SCHEMA.PARAMETERS "+
			"WHERE specific_name = 'add_two' ORDER BY ordinal_position"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	want := [][]string{
		{"a", "IN", "INT64"},
		{"b", "IN", "INT64"},
	}
	for i, w := range want {
		for j, exp := range w {
			if got := rows[i][j].(string); got != exp {
				t.Errorf("row[%d][%d] = %v, want %v", i, j, got, exp)
			}
		}
	}
}

func TestInfoJobsAfterQuery(t *testing.T) {
	client, _ := newClient(t)
	seedInfoSchema(t, client)
	for i := 0; i < 3; i++ {
		if _, err := readAll(t, client.Query("SELECT 1")); err != nil {
			t.Fatalf("seed query: %v", err)
		}
	}
	rows, err := readAll(t, client.Query(
		"SELECT COUNT(*)::INT64 AS n "+
			"FROM `region-us`.INFORMATION_SCHEMA.JOBS WHERE state = 'DONE'"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if got := rows[0][0].(int64); got < 3 {
		t.Errorf("DONE jobs = %d, want >= 3", got)
	}
}
