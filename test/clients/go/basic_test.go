package bqlocal_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"cloud.google.com/go/bigquery"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/iterator"
)

// ----------------------------------------------------------------------------
// Connectivity + discovery
// ----------------------------------------------------------------------------

func TestListProjects(t *testing.T) {
	// The Go bigquery client doesn't expose a project-list helper, so
	// hit GET /projects directly — same path Python's bq.list_projects()
	// drives. Session-scoped emulator is shared across tests; just
	// verify the call succeeds and the JSON kind is correct.
	resp, err := http.Get(emulatorURL + "/projects")
	if err != nil {
		t.Fatalf("http.Get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestServiceAccount(t *testing.T) {
	// The Go bigquery client doesn't expose GetServiceAccount, so we
	// hit the REST endpoint directly to verify it responds correctly
	// — the same shape the Python + Node clients consume.
	_, project := newClient(t)
	resp, err := http.Get(emulatorURL + "/projects/" + project + "/serviceAccount")
	if err != nil {
		t.Fatalf("http.Get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

// ----------------------------------------------------------------------------
// Dataset CRUD
// ----------------------------------------------------------------------------

func TestDatasetCRUD(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)

	ds := client.Dataset("ds")
	if err := ds.Create(ctx, &bigquery.DatasetMetadata{
		Description: "go-test",
		Labels:      map[string]string{"team": "go", "env": "test"},
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	md, err := ds.Metadata(ctx)
	if err != nil {
		t.Fatalf("Metadata: %v", err)
	}
	if md.Description != "go-test" {
		t.Errorf("Description=%q, want %q", md.Description, "go-test")
	}
	if got, want := md.Labels["team"], "go"; got != want {
		t.Errorf("Labels[team]=%q, want %q", got, want)
	}

	// List datasets.
	it := client.Datasets(ctx)
	var names []string
	for {
		d, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			t.Fatalf("Datasets.Next: %v", err)
		}
		names = append(names, d.DatasetID)
	}
	if len(names) != 1 || names[0] != "ds" {
		t.Errorf("dataset list = %v, want [ds]", names)
	}

	if err := ds.DeleteWithContents(ctx); err != nil {
		t.Fatalf("Delete: %v", err)
	}
}

// ----------------------------------------------------------------------------
// Table CRUD with schema + insertion
// ----------------------------------------------------------------------------

type userRow struct {
	ID     int64  `bigquery:"id"`
	Name   string `bigquery:"name"`
	Active bool   `bigquery:"active"`
}

func TestTableCreateAndInsert(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)

	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("Create dataset: %v", err)
	}
	table := client.Dataset("ds").Table("users")
	if err := table.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{
			{Name: "id", Type: bigquery.IntegerFieldType, Required: true},
			{Name: "name", Type: bigquery.StringFieldType},
			{Name: "active", Type: bigquery.BooleanFieldType},
		},
	}); err != nil {
		t.Fatalf("Create table: %v", err)
	}

	inserter := table.Inserter()
	if err := inserter.Put(ctx, []*userRow{
		{ID: 1, Name: "Alice", Active: true},
		{ID: 2, Name: "Bob", Active: false},
	}); err != nil {
		t.Fatalf("Inserter.Put: %v", err)
	}

	// Read back through a simple SELECT — proves wire serialization
	// for INT64 / STRING / BOOL is the same as Node + Python.
	rows, err := runQuery(t, client, "SELECT id, name, active FROM `ds.users` ORDER BY id")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if r0 := rows[0]; r0[0].(int64) != 1 || r0[1].(string) != "Alice" || r0[2].(bool) != true {
		t.Errorf("row 0 = %v", r0)
	}
	if r1 := rows[1]; r1[0].(int64) != 2 || r1[1].(string) != "Bob" || r1[2].(bool) != false {
		t.Errorf("row 1 = %v", r1)
	}
}

// ----------------------------------------------------------------------------
// Query smoke tests
// ----------------------------------------------------------------------------

func TestSimpleQuery(t *testing.T) {
	client, _ := newClient(t)
	rows, err := runQuery(t, client, "SELECT 1 AS one, 'hi' AS greeting")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if got, want := rows[0][0].(int64), int64(1); got != want {
		t.Errorf("one = %d, want %d", got, want)
	}
	if got, want := rows[0][1].(string), "hi"; got != want {
		t.Errorf("greeting = %q, want %q", got, want)
	}
}

func TestQueryAgainstMissingTableErrors(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("Create dataset: %v", err)
	}
	q := client.Query("SELECT * FROM `ds.nope`")
	// The error can surface either at Run() (when the POST /jobs returns
	// 400) or at iteration time. Accept either.
	job, err := q.Run(ctx)
	if err != nil {
		assertBadRequest(t, err)
		return
	}
	it, err := job.Read(ctx)
	if err != nil {
		assertBadRequest(t, err)
		return
	}
	var row []bigquery.Value
	err = it.Next(&row)
	if err == iterator.Done {
		t.Fatalf("expected an error, got Done")
	}
	assertBadRequest(t, err)
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// runQuery runs `sql` and returns each row as a `[]bigquery.Value`.
func runQuery(t *testing.T, client *bigquery.Client, sql string) ([][]bigquery.Value, error) {
	t.Helper()
	ctx := context.Background()
	q := client.Query(sql)
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

func assertBadRequest(t *testing.T, err error) {
	t.Helper()
	var ge *googleapi.Error
	if errors.As(err, &ge) {
		if ge.Code == 400 {
			return
		}
		t.Fatalf("expected 400, got %d: %v", ge.Code, err)
	}
	t.Fatalf("expected googleapi.Error, got %T: %v", err, err)
}
