// Partitioning + clustering coverage:
//   - Ingestion-time partitioning + hidden _PARTITIONTIME column
//   - Column partitioning (TimePartitioning.Field)
//   - Clustering metadata
//   - is_partitioning_column via INFORMATION_SCHEMA.COLUMNS
package bqlocal_test

import (
	"context"
	"testing"

	"cloud.google.com/go/bigquery"
)

func TestIngestionTimePartitioning(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	table := client.Dataset("ds").Table("events")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema:           bigquery.Schema{{Name: "kind", Type: bigquery.StringFieldType}},
		TimePartitioning: &bigquery.TimePartitioning{Type: bigquery.DayPartitioningType},
	}); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if err := table.Inserter().Put(ctx, []*struct {
		Kind string `bigquery:"kind"`
	}{{Kind: "click"}, {Kind: "view"}}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	rows, err := readAll(t, client.Query(
		"SELECT kind, _PARTITIONTIME IS NOT NULL AS has_ts "+
			"FROM `ds.events` ORDER BY kind"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	for _, r := range rows {
		if !r[1].(bool) {
			t.Errorf("_PARTITIONTIME missing for %v", r[0])
		}
	}
}

func TestPartitionDateFilterToday(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	table := client.Dataset("ds").Table("events")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema:           bigquery.Schema{{Name: "kind", Type: bigquery.StringFieldType}},
		TimePartitioning: &bigquery.TimePartitioning{Type: bigquery.DayPartitioningType},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := table.Inserter().Put(ctx, []*struct {
		Kind string `bigquery:"kind"`
	}{{Kind: "a"}, {Kind: "b"}}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	rows, err := readAll(t, client.Query(
		"SELECT count(*)::INT64 AS n FROM `ds.events` "+
			"WHERE _PARTITIONDATE = CURRENT_DATE()"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if rows[0][0].(int64) != 2 {
		t.Errorf("partition count = %v, want 2", rows[0][0])
	}
}

func TestColumnPartitioningRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	table := client.Dataset("ds").Table("orders")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType},
			{Name: "order_date", Type: bigquery.DateFieldType},
			{Name: "amount", Type: bigquery.FloatFieldType},
		},
		TimePartitioning: &bigquery.TimePartitioning{
			Type:  bigquery.DayPartitioningType,
			Field: "order_date",
		},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	md, err := table.Metadata(ctx)
	if err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if md.TimePartitioning == nil {
		t.Fatal("expected TimePartitioning, got nil")
	}
	if got := md.TimePartitioning.Type; got != bigquery.DayPartitioningType {
		t.Errorf("type = %v, want DAY", got)
	}
	if got := md.TimePartitioning.Field; got != "order_date" {
		t.Errorf("field = %v, want order_date", got)
	}
}

func TestClusteringMetadataRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	table := client.Dataset("ds").Table("sessions")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "user_id", Type: bigquery.StringFieldType},
			{Name: "session_id", Type: bigquery.StringFieldType},
			{Name: "started_at", Type: bigquery.TimestampFieldType},
		},
		Clustering: &bigquery.Clustering{Fields: []string{"user_id", "session_id"}},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	md, err := table.Metadata(ctx)
	if err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if md.Clustering == nil {
		t.Fatal("expected Clustering, got nil")
	}
	want := []string{"user_id", "session_id"}
	if len(md.Clustering.Fields) != len(want) {
		t.Fatalf("fields = %v, want %v", md.Clustering.Fields, want)
	}
	for i, f := range md.Clustering.Fields {
		if f != want[i] {
			t.Errorf("fields[%d] = %v, want %v", i, f, want[i])
		}
	}
}

func TestIsPartitioningColumnViaInformationSchema(t *testing.T) {
	ctx := context.Background()
	client, project := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	table := client.Dataset("ds").Table("orders")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType},
			{Name: "order_date", Type: bigquery.DateFieldType},
		},
		TimePartitioning: &bigquery.TimePartitioning{
			Type:  bigquery.DayPartitioningType,
			Field: "order_date",
		},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	rows, err := readAll(t, client.Query(
		"SELECT column_name, is_partitioning_column "+
			"FROM `"+project+".ds`.INFORMATION_SCHEMA.COLUMNS "+
			"WHERE table_name = 'orders' ORDER BY ordinal_position"))
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	byName := map[string]string{}
	for _, r := range rows {
		byName[r[0].(string)] = r[1].(string)
	}
	if byName["id"] != "NO" || byName["order_date"] != "YES" {
		t.Errorf("is_partitioning_column = %v, want {id:NO, order_date:YES}", byName)
	}
}
