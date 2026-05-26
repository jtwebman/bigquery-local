// Load / Extract / Copy job coverage through the Go bigquery client.
//
// The session-scoped GCS stub from main_test.go backs every URI; the
// emulator was spawned with STORAGE_EMULATOR_HOST pointed at it, so
// `gs://...` source/destination URIs round-trip through the stub.
//
// Covers:
//   - BL-083 Load CSV with autodetect + explicit schema
//   - BL-084 Load NDJSON with autodetect
//   - BL-085 Load Parquet (round-trip via extract → load)
//   - BL-094 Extract to CSV + NDJSON
//   - BL-095 Copy table (default + WRITE_TRUNCATE)
package bqlocal_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"cloud.google.com/go/bigquery"
)

func randSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// ---------------------------------------------------------------------------
// Load: CSV
// ---------------------------------------------------------------------------

func TestLoadCSVFromGCSWithAutodetect(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	bucket := "go-load-" + randSuffix(t)
	gcsStub.put(bucket, "orders.csv", []byte(
		"order_id,customer,amount,delivered\n"+
			"1,Alice,9.99,true\n"+
			"2,Bob,12.50,false\n"+
			"3,Charlie,7.00,true\n"), "text/csv")

	src := bigquery.NewGCSReference("gs://" + bucket + "/orders.csv")
	src.SourceFormat = bigquery.CSV
	src.AutoDetect = true
	loader := client.Dataset("ds").Table("orders").LoaderFrom(src)
	job, err := loader.Run(ctx)
	if err != nil {
		t.Fatalf("loader.Run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("load wait: %v", err)
	}
	rows, err := readAll(t, client.Query("SELECT count(*)::INT64 AS n FROM `ds.orders`"))
	if err != nil {
		t.Fatalf("count query: %v", err)
	}
	if rows[0][0].(int64) != 3 {
		t.Errorf("loaded rows = %d, want 3", rows[0][0])
	}
}

func TestLoadCSVWithExplicitSchema(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	bucket := "go-load-" + randSuffix(t)
	gcsStub.put(bucket, "notes.csv", []byte("id,note\n1,first\n2,second\n"), "text/csv")

	src := bigquery.NewGCSReference("gs://" + bucket + "/notes.csv")
	src.SourceFormat = bigquery.CSV
	src.SkipLeadingRows = 1
	src.Schema = bigquery.Schema{
		{Name: "id", Type: bigquery.StringFieldType, Required: true},
		{Name: "note", Type: bigquery.StringFieldType},
	}
	job, err := client.Dataset("ds").Table("notes").LoaderFrom(src).Run(ctx)
	if err != nil {
		t.Fatalf("load run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("load wait: %v", err)
	}
	rows, err := readAll(t, client.Query("SELECT id, note FROM `ds.notes` ORDER BY id"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	want := [][]string{{"1", "first"}, {"2", "second"}}
	for i, w := range want {
		if rows[i][0].(string) != w[0] || rows[i][1].(string) != w[1] {
			t.Errorf("row[%d] = %v, want %v", i, rows[i], w)
		}
	}
}

// ---------------------------------------------------------------------------
// Load: NDJSON
// ---------------------------------------------------------------------------

func TestLoadNDJSONFromGCSWithAutodetect(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	bucket := "go-load-" + randSuffix(t)
	gcsStub.put(bucket, "events.ndjson",
		[]byte(`{"id":1,"kind":"click"}`+"\n"+`{"id":2,"kind":"view"}`+"\n"),
		"application/x-ndjson")

	src := bigquery.NewGCSReference("gs://" + bucket + "/events.ndjson")
	src.SourceFormat = bigquery.JSON
	src.AutoDetect = true
	job, err := client.Dataset("ds").Table("events").LoaderFrom(src).Run(ctx)
	if err != nil {
		t.Fatalf("load run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("load wait: %v", err)
	}
	rows, err := readAll(t, client.Query("SELECT id, kind FROM `ds.events` ORDER BY id"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if rows[0][0].(int64) != 1 || rows[0][1].(string) != "click" {
		t.Errorf("row 0 = %v, want [1 click]", rows[0])
	}
	if rows[1][0].(int64) != 2 || rows[1][1].(string) != "view" {
		t.Errorf("row 1 = %v, want [2 view]", rows[1])
	}
}

// ---------------------------------------------------------------------------
// Load: Parquet (round-trip via extract → load)
// ---------------------------------------------------------------------------

func TestLoadParquetFromGCS(t *testing.T) {
	ctx := context.Background()
	client, project := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	if err := client.Dataset(project + "_src").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("src dataset: %v", err)
	}
	src := client.Dataset(project + "_src").Table("fixture")
	if err := src.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType},
			{Name: "label", Type: bigquery.StringFieldType},
		},
	}); err != nil {
		t.Fatalf("create src: %v", err)
	}
	if err := src.Inserter().Put(ctx, []*struct {
		ID    int64  `bigquery:"id"`
		Label string `bigquery:"label"`
	}{{ID: 1, Label: "alpha"}, {ID: 2, Label: "beta"}}); err != nil {
		t.Fatalf("insert: %v", err)
	}

	bucket := "go-load-" + randSuffix(t)
	dest := bigquery.NewGCSReference("gs://" + bucket + "/fixture.parquet")
	dest.DestinationFormat = bigquery.Parquet
	ej, err := src.ExtractorTo(dest).Run(ctx)
	if err != nil {
		t.Fatalf("extract run: %v", err)
	}
	if _, err := ej.Wait(ctx); err != nil {
		t.Fatalf("extract wait: %v", err)
	}

	loadSrc := bigquery.NewGCSReference("gs://" + bucket + "/fixture.parquet")
	loadSrc.SourceFormat = bigquery.Parquet
	loadSrc.AutoDetect = true
	lj, err := client.Dataset("ds").Table("from_parquet").LoaderFrom(loadSrc).Run(ctx)
	if err != nil {
		t.Fatalf("load run: %v", err)
	}
	if _, err := lj.Wait(ctx); err != nil {
		t.Fatalf("load wait: %v", err)
	}
	rows, err := readAll(t, client.Query("SELECT id, label FROM `ds.from_parquet` ORDER BY id"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	want := [][]any{{int64(1), "alpha"}, {int64(2), "beta"}}
	for i, w := range want {
		if rows[i][0] != w[0] || rows[i][1] != w[1] {
			t.Errorf("row[%d] = %v, want %v", i, rows[i], w)
		}
	}
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

func TestExtractCSVWritesHeaderAndRows(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	tbl := client.Dataset("ds").Table("users")
	if err := tbl.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType},
			{Name: "name", Type: bigquery.StringFieldType},
		},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := tbl.Inserter().Put(ctx, []*struct {
		ID   int64  `bigquery:"id"`
		Name string `bigquery:"name"`
	}{{ID: 1, Name: "Alice"}, {ID: 2, Name: "Bob"}}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	bucket := "go-extract-" + randSuffix(t)
	dest := bigquery.NewGCSReference("gs://" + bucket + "/users.csv")
	dest.DestinationFormat = bigquery.CSV
	job, err := tbl.ExtractorTo(dest).Run(ctx)
	if err != nil {
		t.Fatalf("extract run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("extract wait: %v", err)
	}
	stored, ok := gcsStub.get(bucket, "users.csv")
	if !ok {
		t.Fatal("extracted object missing from stub")
	}
	lines := []string{}
	for _, line := range strings.Split(string(stored.bytes), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	if lines[0] != "id,name" {
		t.Errorf("header = %q, want id,name", lines[0])
	}
	rest := lines[1:]
	sort.Strings(rest)
	if rest[0] != "1,Alice" || rest[1] != "2,Bob" {
		t.Errorf("body = %v, want [1,Alice 2,Bob]", rest)
	}
}

func TestExtractNDJSONRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	tbl := client.Dataset("ds").Table("events")
	if err := tbl.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType},
			{Name: "kind", Type: bigquery.StringFieldType},
		},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := tbl.Inserter().Put(ctx, []*struct {
		ID   int64  `bigquery:"id"`
		Kind string `bigquery:"kind"`
	}{{ID: 7, Kind: "click"}}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	bucket := "go-extract-" + randSuffix(t)
	dest := bigquery.NewGCSReference("gs://" + bucket + "/events.ndjson")
	dest.DestinationFormat = bigquery.JSON
	job, err := tbl.ExtractorTo(dest).Run(ctx)
	if err != nil {
		t.Fatalf("extract run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("extract wait: %v", err)
	}
	stored, ok := gcsStub.get(bucket, "events.ndjson")
	if !ok {
		t.Fatal("extract output missing")
	}
	var parsed []map[string]any
	for _, line := range strings.Split(string(stored.bytes), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("json decode: %v (line=%q)", err, line)
		}
		parsed = append(parsed, m)
	}
	if len(parsed) != 1 {
		t.Fatalf("parsed = %d lines, want 1", len(parsed))
	}
	// BQ NDJSON extract emits INT64 as a string (matches real BQ output).
	if parsed[0]["id"] != "7" || parsed[0]["kind"] != "click" {
		t.Errorf("ndjson row = %v, want {id:7, kind:click}", parsed[0])
	}
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

func TestCopyTableRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	src := client.Dataset("ds").Table("source")
	dst := client.Dataset("ds").Table("dest")
	if err := src.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType},
			{Name: "label", Type: bigquery.StringFieldType},
		},
	}); err != nil {
		t.Fatalf("create src: %v", err)
	}
	if err := src.Inserter().Put(ctx, []*struct {
		ID    int64  `bigquery:"id"`
		Label string `bigquery:"label"`
	}{{ID: 1, Label: "one"}, {ID: 2, Label: "two"}}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	job, err := dst.CopierFrom(src).Run(ctx)
	if err != nil {
		t.Fatalf("copy run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("copy wait: %v", err)
	}
	rows, err := readAll(t, client.Query("SELECT id, label FROM `ds.dest` ORDER BY id"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if rows[0][0].(int64) != 1 || rows[0][1].(string) != "one" {
		t.Errorf("row 0 = %v, want [1 one]", rows[0])
	}
	if rows[1][0].(int64) != 2 || rows[1][1].(string) != "two" {
		t.Errorf("row 1 = %v, want [2 two]", rows[1])
	}
}

func TestCopyWithWriteTruncateOverwritesDestination(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	src := client.Dataset("ds").Table("src")
	dst := client.Dataset("ds").Table("dst")
	for _, ref := range []*bigquery.Table{src, dst} {
		if err := ref.Create(ctx, &bigquery.TableMetadata{
			Schema: bigquery.Schema{{Name: "v", Type: bigquery.IntegerFieldType}},
		}); err != nil {
			t.Fatalf("create %s: %v", ref.TableID, err)
		}
	}
	type vrow struct {
		V int64 `bigquery:"v"`
	}
	if err := src.Inserter().Put(ctx, []*vrow{{V: 1}, {V: 2}, {V: 3}}); err != nil {
		t.Fatalf("insert src: %v", err)
	}
	if err := dst.Inserter().Put(ctx, []*vrow{{V: 999}}); err != nil {
		t.Fatalf("insert dst: %v", err)
	}
	copier := dst.CopierFrom(src)
	copier.WriteDisposition = bigquery.WriteTruncate
	job, err := copier.Run(ctx)
	if err != nil {
		t.Fatalf("copy run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("copy wait: %v", err)
	}
	rows, err := readAll(t, client.Query("SELECT v FROM `ds.dst` ORDER BY v"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	want := []int64{1, 2, 3}
	for i, w := range want {
		if got := rows[i][0].(int64); got != w {
			t.Errorf("row[%d] = %d, want %d", i, got, w)
		}
	}
}
