// Advanced 1.0.0 features:
//   - Labels propagation on tables + jobs (BL-154)
//   - Dataset locations (BL-155)
//   - useQueryCache (BL-157)
//   - Multi-project isolation
package bqlocal_test

import (
	"context"
	"testing"

	"cloud.google.com/go/bigquery"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
)

// ---------------------------------------------------------------------------
// Labels (BL-154)
// ---------------------------------------------------------------------------

func TestTableLabelsCreateRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	if err := client.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("dataset: %v", err)
	}
	tbl := client.Dataset("ds").Table("t")
	if err := tbl.Create(ctx, &bigquery.TableMetadata{
		Schema: bigquery.Schema{{Name: "id", Type: bigquery.IntegerFieldType}},
		Labels: map[string]string{"team": "platform", "env": "test"},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	md, err := tbl.Metadata(ctx)
	if err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if md.Labels["team"] != "platform" || md.Labels["env"] != "test" {
		t.Errorf("labels = %v, want {team:platform, env:test}", md.Labels)
	}
}

func TestJobLabelsRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	q := client.Query("SELECT 1 AS one")
	q.Labels = map[string]string{"owner": "go-test", "priority": "low"}
	job, err := q.Run(ctx)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if _, err := job.Wait(ctx); err != nil {
		t.Fatalf("wait: %v", err)
	}
	// Re-fetch job to verify labels survived storage.
	fetched, err := client.JobFromID(ctx, job.ID())
	if err != nil {
		t.Fatalf("get job: %v", err)
	}
	cfg, err := fetched.Config()
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	qc, ok := cfg.(*bigquery.QueryConfig)
	if !ok {
		t.Fatalf("config type = %T", cfg)
	}
	if qc.Labels["owner"] != "go-test" || qc.Labels["priority"] != "low" {
		t.Errorf("labels = %v, want {owner:go-test, priority:low}", qc.Labels)
	}
}

// ---------------------------------------------------------------------------
// Locations (BL-155)
// ---------------------------------------------------------------------------

func TestDatasetLocationRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	ds := client.Dataset("eu_ds")
	if err := ds.Create(ctx, &bigquery.DatasetMetadata{Location: "EU"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	md, err := ds.Metadata(ctx)
	if err != nil {
		t.Fatalf("metadata: %v", err)
	}
	if md.Location != "EU" {
		t.Errorf("location = %q, want EU", md.Location)
	}
}

// ---------------------------------------------------------------------------
// Query cache (BL-157)
// ---------------------------------------------------------------------------

func TestUseQueryCacheDefaultHitsOnSecondRun(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	sql := "SELECT 'go-cache' AS marker, 1 AS one"
	// First run primes the cache.
	first := client.Query(sql)
	job1, err := first.Run(ctx)
	if err != nil {
		t.Fatalf("run 1: %v", err)
	}
	if _, err := job1.Wait(ctx); err != nil {
		t.Fatalf("wait 1: %v", err)
	}
	cfg1, _ := job1.Config()
	// First run can't be a cache hit.
	if qstats := lastStatistics(job1).Details; qstats != nil {
		if qd, ok := qstats.(*bigquery.QueryStatistics); ok && qd.CacheHit {
			t.Errorf("first run reported cache hit")
		}
	}
	_ = cfg1
	// Second run hits.
	second := client.Query(sql)
	job2, err := second.Run(ctx)
	if err != nil {
		t.Fatalf("run 2: %v", err)
	}
	if _, err := job2.Wait(ctx); err != nil {
		t.Fatalf("wait 2: %v", err)
	}
	qstats := lastStatistics(job2).Details
	qd, ok := qstats.(*bigquery.QueryStatistics)
	if !ok {
		t.Fatalf("second statistics = %T, want *QueryStatistics", qstats)
	}
	if !qd.CacheHit {
		t.Errorf("second run cache_hit = false, want true")
	}
}

func TestUseQueryCacheFalseBypasses(t *testing.T) {
	ctx := context.Background()
	client, _ := newClient(t)
	sql := "SELECT 'go-cache-bypass' AS marker"
	prime := client.Query(sql)
	pj, _ := prime.Run(ctx)
	if _, err := pj.Wait(ctx); err != nil {
		t.Fatalf("prime: %v", err)
	}
	bypassed := client.Query(sql)
	bypassed.DisableQueryCache = true
	bj, err := bypassed.Run(ctx)
	if err != nil {
		t.Fatalf("bypass run: %v", err)
	}
	if _, err := bj.Wait(ctx); err != nil {
		t.Fatalf("bypass wait: %v", err)
	}
	qd := lastStatistics(bj).Details.(*bigquery.QueryStatistics)
	if qd.CacheHit {
		t.Errorf("bypass cache_hit = true, want false")
	}
}

// ---------------------------------------------------------------------------
// Multi-project isolation
// ---------------------------------------------------------------------------

func TestTwoProjectsCanHaveSameDatasetID(t *testing.T) {
	ctx := context.Background()
	// Use uniqueProject for the base project and derive -a / -b children
	// so we don't collide with other concurrent tests.
	base := uniqueProject(t)
	pa, pb := base+"a", base+"b"

	clientA, err := bigquery.NewClient(ctx, pa,
		option.WithEndpoint(emulatorURL),
		option.WithoutAuthentication())
	if err != nil {
		t.Fatalf("client a: %v", err)
	}
	defer clientA.Close()
	clientB, err := bigquery.NewClient(ctx, pb,
		option.WithEndpoint(emulatorURL),
		option.WithoutAuthentication())
	if err != nil {
		t.Fatalf("client b: %v", err)
	}
	defer clientB.Close()

	if err := clientA.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("create a/ds: %v", err)
	}
	if err := clientB.Dataset("ds").Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("create b/ds: %v", err)
	}
	listDS := func(c *bigquery.Client) []string {
		it := c.Datasets(ctx)
		var names []string
		for {
			d, err := it.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			names = append(names, d.DatasetID)
		}
		return names
	}
	if got := listDS(clientA); len(got) != 1 || got[0] != "ds" {
		t.Errorf("project a datasets = %v, want [ds]", got)
	}
	if got := listDS(clientB); len(got) != 1 || got[0] != "ds" {
		t.Errorf("project b datasets = %v, want [ds]", got)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func lastStatistics(j *bigquery.Job) *bigquery.JobStatistics {
	s := j.LastStatus()
	if s == nil {
		return &bigquery.JobStatistics{}
	}
	return s.Statistics
}
