// SQL feature happy-path coverage through the Go bigquery client.
//
// Each test exercises a 1.0.0 SQL feature end-to-end: query parameters,
// DML, MERGE/QUALIFY/PIVOT, window + CTE, ARRAY_AGG/UNNEST, JSON,
// scripts, transactions, dry-run, wildcard tables.
package bqlocal_test

import (
	"context"
	"sort"
	"testing"

	"cloud.google.com/go/bigquery"
	"google.golang.org/api/iterator"
)

type orderRow struct {
	Region  string `bigquery:"region"`
	Product string `bigquery:"product"`
	Amount  int64  `bigquery:"amount"`
}

func seedOrders(t *testing.T, client *bigquery.Client) string {
	t.Helper()
	ctx := context.Background()
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("create dataset: %v", err)
	}
	table := client.Dataset("ds").Table("orders")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "region", Type: bigquery.StringFieldType},
			{Name: "product", Type: bigquery.StringFieldType},
			{Name: "amount", Type: bigquery.IntegerFieldType},
		},
	}); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if err := table.Inserter().Put(ctx, []*orderRow{
		{Region: "east", Product: "a", Amount: 10},
		{Region: "east", Product: "b", Amount: 20},
		{Region: "east", Product: "c", Amount: 5},
		{Region: "west", Product: "a", Amount: 30},
		{Region: "west", Product: "b", Amount: 40},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	return client.Project() + ".ds.orders"
}

// ---------------------------------------------------------------------------
// Parameter shapes
// ---------------------------------------------------------------------------

func TestNamedScalarIntParameter(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	q := client.Query("SELECT count(*) AS n FROM `" + fqn + "` WHERE amount >= @threshold")
	q.Parameters = []bigquery.QueryParameter{{Name: "threshold", Value: int64(20)}}
	rows, err := readAll(t, q)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if got := rows[0][0].(int64); got != 3 {
		t.Errorf("count = %d, want 3", got)
	}
}

func TestNamedScalarStringParameter(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	q := client.Query("SELECT count(*) AS n FROM `" + fqn + "` WHERE region = @r")
	q.Parameters = []bigquery.QueryParameter{{Name: "r", Value: "east"}}
	rows, err := readAll(t, q)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if got := rows[0][0].(int64); got != 3 {
		t.Errorf("count = %d, want 3", got)
	}
}

func TestArrayParameterUnnest(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	q := client.Query("SELECT amount FROM `" + fqn + "` WHERE amount IN UNNEST(@targets) ORDER BY amount")
	q.Parameters = []bigquery.QueryParameter{{Name: "targets", Value: []int64{10, 30}}}
	rows, err := readAll(t, q)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	got := []int64{rows[0][0].(int64), rows[1][0].(int64)}
	if got[0] != 10 || got[1] != 30 {
		t.Errorf("amounts = %v, want [10 30]", got)
	}
}

// ---------------------------------------------------------------------------
// SQL idioms: MERGE, QUALIFY, PIVOT, CTE+window, ARRAY_AGG, JSON, TIMESTAMP
// ---------------------------------------------------------------------------

func TestMergeInsertsAndUpdates(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	if _, err := readAll(t, client.Query(`
		MERGE INTO `+"`"+fqn+"`"+` AS target
		USING (SELECT 'east' AS region, 'a' AS product, 999 AS amount) AS src
		ON target.region = src.region AND target.product = src.product
		WHEN MATCHED THEN UPDATE SET amount = src.amount
		WHEN NOT MATCHED THEN INSERT (region, product, amount) VALUES (src.region, src.product, src.amount)
	`)); err != nil {
		t.Fatalf("merge: %v", err)
	}
	rows, _ := readAll(t, client.Query(
		"SELECT amount FROM `"+fqn+"` WHERE region = 'east' AND product = 'a'"))
	if rows[0][0].(int64) != 999 {
		t.Errorf("after MERGE amount = %v, want 999", rows[0][0])
	}
}

func TestQualifyRowNumberPerPartition(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	rows, err := readAll(t, client.Query(`
		SELECT region, product, amount FROM `+"`"+fqn+"`"+`
		QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) = 1
		ORDER BY region
	`))
	if err != nil {
		t.Fatalf("qualify: %v", err)
	}
	byRegion := map[string]string{
		rows[0][0].(string): rows[0][1].(string),
		rows[1][0].(string): rows[1][1].(string),
	}
	if byRegion["east"] != "b" || byRegion["west"] != "b" {
		t.Errorf("top earners = %v", byRegion)
	}
}

func TestPivot(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	rows, err := readAll(t, client.Query(`
		SELECT * FROM (
		  SELECT region, product, amount FROM `+"`"+fqn+"`"+`
		) PIVOT (
		  SUM(amount) FOR product IN ('a', 'b', 'c')
		)
		ORDER BY region
	`))
	if err != nil {
		t.Fatalf("pivot: %v", err)
	}
	// Header order: region, a, b, c (or w/e the engine emits — fetch by index).
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	// row[0] should be east (alphabetic order)
	r := rows[0]
	if r[0].(string) != "east" {
		t.Errorf("first region = %v, want east", r[0])
	}
	// a=10, b=20, c=5 for east.
	if r[1].(int64) != 10 || r[2].(int64) != 20 || r[3].(int64) != 5 {
		t.Errorf("east row = %v %v %v, want 10 20 5", r[1], r[2], r[3])
	}
}

func TestCTEAndWindow(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	rows, err := readAll(t, client.Query(`
		WITH ranked AS (
		  SELECT region, product, amount,
		         RANK() OVER (PARTITION BY region ORDER BY amount DESC) AS r
		  FROM `+"`"+fqn+"`"+`
		)
		SELECT region, product FROM ranked WHERE r = 1 ORDER BY region
	`))
	if err != nil {
		t.Fatalf("cte: %v", err)
	}
	for _, r := range rows {
		if r[1].(string) != "b" {
			t.Errorf("top earner per region = %v, want b", r[1])
		}
	}
}

func TestApproxCountDistinct(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	rows, err := readAll(t, client.Query(
		"SELECT APPROX_COUNT_DISTINCT(product) AS n FROM `"+fqn+"`"))
	if err != nil {
		t.Fatalf("approx_count_distinct: %v", err)
	}
	// 3 distinct products in fixture.
	if got := rows[0][0].(int64); got != 3 {
		t.Errorf("APPROX_COUNT_DISTINCT = %d, want 3", got)
	}
}

func TestArrayAggAndUnnest(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	rows, err := readAll(t, client.Query(`
		SELECT region, ARRAY_AGG(product ORDER BY product) AS products
		FROM `+"`"+fqn+"`"+`
		GROUP BY region
		ORDER BY region
	`))
	if err != nil {
		t.Fatalf("array_agg: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	east := rows[0][1].([]bigquery.Value)
	if len(east) != 3 || east[0].(string) != "a" || east[1].(string) != "b" || east[2].(string) != "c" {
		t.Errorf("east products = %v, want [a b c]", east)
	}
}

func TestJSONValue(t *testing.T) {
	client, _ := newClient(t)
	rows, err := readAll(t, client.Query(
		`SELECT JSON_VALUE('{"a":{"b":"hello"}}', '$.a.b') AS v`))
	if err != nil {
		t.Fatalf("json_value: %v", err)
	}
	if rows[0][0].(string) != "hello" {
		t.Errorf("v = %v, want hello", rows[0][0])
	}
}

func TestTimestampArithmetic(t *testing.T) {
	client, _ := newClient(t)
	rows, err := readAll(t, client.Query(
		`SELECT TIMESTAMP_DIFF(TIMESTAMP '2026-05-25T00:00:00Z', `+
			`TIMESTAMP '2026-05-24T00:00:00Z', HOUR) AS hours`))
	if err != nil {
		t.Fatalf("timestamp_diff: %v", err)
	}
	if rows[0][0].(int64) != 24 {
		t.Errorf("hours = %v, want 24", rows[0][0])
	}
}

// ---------------------------------------------------------------------------
// DML
// ---------------------------------------------------------------------------

func TestInsertUpdateDelete(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	if _, err := readAll(t, client.Query(
		"INSERT INTO `"+fqn+"` (region, product, amount) VALUES ('south', 'z', 7)")); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if _, err := readAll(t, client.Query(
		"UPDATE `"+fqn+"` SET amount = 8 WHERE region = 'south'")); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, err := readAll(t, client.Query(
		"DELETE FROM `"+fqn+"` WHERE region = 'south'")); err != nil {
		t.Fatalf("delete: %v", err)
	}
	rows, _ := readAll(t, client.Query(
		"SELECT count(*) AS n FROM `"+fqn+"` WHERE region = 'south'"))
	if rows[0][0].(int64) != 0 {
		t.Errorf("residual rows = %v, want 0", rows[0][0])
	}
}

func TestTruncateTablePreservesSchema(t *testing.T) {
	client, project := newClient(t)
	fqn := seedOrders(t, client)
	if _, err := readAll(t, client.Query("TRUNCATE TABLE `"+fqn+"`")); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	rows, _ := readAll(t, client.Query("SELECT count(*) AS n FROM `"+fqn+"`"))
	if rows[0][0].(int64) != 0 {
		t.Errorf("rows after truncate = %v, want 0", rows[0][0])
	}
	cols, _ := readAll(t, client.Query(
		"SELECT column_name FROM `"+project+".ds`.INFORMATION_SCHEMA.COLUMNS "+
			"WHERE table_name = 'orders' ORDER BY ordinal_position"))
	got := []string{cols[0][0].(string), cols[1][0].(string), cols[2][0].(string)}
	want := []string{"region", "product", "amount"}
	for i, g := range got {
		if g != want[i] {
			t.Errorf("column[%d] = %v, want %v", i, g, want[i])
		}
	}
}

// ---------------------------------------------------------------------------
// Scripts + transactions
// ---------------------------------------------------------------------------

func TestMultiStatementScript(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	if _, err := readAll(t, client.Query(`
		BEGIN
		  DECLARE total INT64 DEFAULT 0;
		  SET total = (SELECT SUM(amount) FROM `+"`"+fqn+"`"+`);
		  INSERT INTO `+"`"+fqn+"`"+` (region, product, amount) VALUES ('total', 'sum', total);
		END;
	`)); err != nil {
		t.Fatalf("script: %v", err)
	}
	rows, _ := readAll(t, client.Query(
		"SELECT amount FROM `"+fqn+"` WHERE region = 'total'"))
	if rows[0][0].(int64) != 105 {
		t.Errorf("total = %v, want 105", rows[0][0])
	}
}

func TestTransactionCommit(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	if _, err := readAll(t, client.Query(`
		BEGIN TRANSACTION;
		INSERT INTO `+"`"+fqn+"`"+` (region, product, amount) VALUES ('north', 'x', 1);
		COMMIT;
	`)); err != nil {
		t.Fatalf("transaction: %v", err)
	}
	rows, _ := readAll(t, client.Query(
		"SELECT count(*) AS n FROM `"+fqn+"` WHERE region = 'north'"))
	if rows[0][0].(int64) != 1 {
		t.Errorf("rows after commit = %v, want 1", rows[0][0])
	}
}

// ---------------------------------------------------------------------------
// Dry-run + cost
// ---------------------------------------------------------------------------

func TestDryRunReportsBytes(t *testing.T) {
	client, _ := newClient(t)
	fqn := seedOrders(t, client)
	ctx := context.Background()
	q := client.Query("SELECT * FROM `" + fqn + "`")
	q.DryRun = true
	q.DisableQueryCache = true
	job, err := q.Run(ctx)
	if err != nil {
		t.Fatalf("dry-run: %v", err)
	}
	// Dry-run jobs are not persisted server-side (matches real BQ).
	// The statistics returned synchronously by Run() are on LastStatus().
	status := job.LastStatus()
	if status == nil || status.Statistics == nil || status.Statistics.TotalBytesProcessed == 0 {
		t.Errorf("expected non-zero TotalBytesProcessed, got %+v", status)
	}
}

// ---------------------------------------------------------------------------
// Wildcard tables
// ---------------------------------------------------------------------------

func TestWildcardTables(t *testing.T) {
	ctx := context.Background()
	client, project := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	suffixes := []string{"20260101", "20260102", "20260103"}
	for i, suf := range suffixes {
		table := client.Dataset("ds").Table("events_" + suf)
		if err := table.Create(ctx, &bigquery.TableMetadata{
			Schema: bigquery.Schema{{Name: "id", Type: bigquery.IntegerFieldType}},
		}); err != nil {
			t.Fatalf("create %s: %v", suf, err)
		}
		if err := table.Inserter().Put(ctx, []*struct {
			ID int64 `bigquery:"id"`
		}{{ID: int64(i + 1)}}); err != nil {
			t.Fatalf("insert %s: %v", suf, err)
		}
	}
	rows, err := readAll(t, client.Query(
		"SELECT _TABLE_SUFFIX AS suf, id FROM `"+project+".ds.events_*` ORDER BY suf"))
	if err != nil {
		t.Fatalf("wildcard: %v", err)
	}
	got := make([][2]any, len(rows))
	for i, r := range rows {
		got[i] = [2]any{r[0].(string), r[1].(int64)}
	}
	sort.Slice(got, func(i, j int) bool { return got[i][0].(string) < got[j][0].(string) })
	want := [][2]any{
		{"20260101", int64(1)},
		{"20260102", int64(2)},
		{"20260103", int64(3)},
	}
	for i, g := range got {
		if g != want[i] {
			t.Errorf("row[%d] = %v, want %v", i, g, want[i])
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// readAll runs a query and returns all rows. Used wherever the test
// doesn't care about column metadata, only values.
func readAll(t *testing.T, q *bigquery.Query) ([][]bigquery.Value, error) {
	t.Helper()
	ctx := context.Background()
	it, err := q.Read(ctx)
	if err != nil {
		return nil, err
	}
	var rows [][]bigquery.Value
	for {
		var row []bigquery.Value
		err := it.Next(&row)
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
