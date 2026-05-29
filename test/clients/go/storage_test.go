// Storage Read API integration test.
//
// Uses the official `cloud.google.com/go/bigquery/storage/apiv1`
// client pointed at our gRPC port with an insecure channel. Sets up
// a table via REST, then reads it back via CreateReadSession +
// ReadRows. Skipped unless the storage package compiles cleanly.

package bqlocal_test

import (
	"context"
	"io"
	"testing"

	"cloud.google.com/go/bigquery"
	storage "cloud.google.com/go/bigquery/storage/apiv1"
	"cloud.google.com/go/bigquery/storage/apiv1/storagepb"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func TestStorageReadEndToEnd(t *testing.T) {
	ctx := context.Background()
	bq, project := newClient(t)
	defer bq.Close()

	dataset := bq.Dataset("ds_storage")
	if err := dataset.Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("create dataset: %v", err)
	}
	table := dataset.Table("storage_target")
	schema := bigquery.Schema{
		{Name: "id", Type: bigquery.IntegerFieldType, Required: true},
		{Name: "name", Type: bigquery.StringFieldType},
	}
	if err := table.Create(ctx, &bigquery.TableMetadata{Schema: schema}); err != nil {
		t.Fatalf("create table: %v", err)
	}
	type row struct {
		ID   int64  `bigquery:"id"`
		Name string `bigquery:"name"`
	}
	rows := []row{{ID: 1, Name: "alice"}, {ID: 2, Name: "bob"}}
	if err := table.Inserter().Put(ctx, rows); err != nil {
		t.Fatalf("insert rows: %v", err)
	}

	// Storage Read client — insecure gRPC against the emulator's gRPC port.
	conn, err := grpc.NewClient(
		emulatorGRPC,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}
	defer conn.Close()
	readClient, err := storage.NewBigQueryReadClient(
		ctx,
		option.WithGRPCConn(conn),
		option.WithoutAuthentication(),
	)
	if err != nil {
		t.Fatalf("NewBigQueryReadClient: %v", err)
	}
	defer readClient.Close()

	session, err := readClient.CreateReadSession(ctx, &storagepb.CreateReadSessionRequest{
		Parent: "projects/" + project,
		ReadSession: &storagepb.ReadSession{
			Table: "projects/" + project + "/datasets/ds_storage/tables/storage_target",
			DataFormat: storagepb.DataFormat_AVRO,
		},
	})
	if err != nil {
		t.Fatalf("CreateReadSession: %v", err)
	}
	if len(session.Streams) < 1 {
		t.Fatalf("expected at least one stream, got %d", len(session.Streams))
	}
	if session.EstimatedRowCount != 2 {
		t.Fatalf("expected 2 rows, got %d", session.EstimatedRowCount)
	}
	if session.GetAvroSchema() == nil {
		t.Fatalf("expected avro schema, got nil")
	}

	stream, err := readClient.ReadRows(ctx, &storagepb.ReadRowsRequest{
		ReadStream: session.Streams[0].Name,
	})
	if err != nil {
		t.Fatalf("ReadRows: %v", err)
	}
	batchesSeen := 0
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		if resp.GetAvroRows() != nil && len(resp.GetAvroRows().SerializedBinaryRows) > 0 {
			batchesSeen++
		}
	}
	if batchesSeen < 1 {
		t.Fatalf("expected at least one batch, got %d", batchesSeen)
	}
}
