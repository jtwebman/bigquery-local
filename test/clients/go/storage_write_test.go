// Storage Write API integration test.
//
// Uses the official `cloud.google.com/go/bigquery/storage/apiv1` write
// client against the emulator's gRPC port over an insecure channel.
// Builds a proto descriptor matching the table schema at runtime via
// `dynamicpb` so we don't need a precompiled .proto file in the test.

package bqlocal_test

import (
	"context"
	"io"
	"testing"

	"cloud.google.com/go/bigquery"
	storage "cloud.google.com/go/bigquery/storage/apiv1"
	"cloud.google.com/go/bigquery/storage/apiv1/storagepb"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

func TestStorageWriteDefaultStream(t *testing.T) {
	ctx := context.Background()
	bq, project := newClient(t)
	defer bq.Close()

	dataset := bq.Dataset("ds_storage_write")
	if err := dataset.Create(ctx, &bigquery.DatasetMetadata{}); err != nil {
		t.Fatalf("create dataset: %v", err)
	}
	table := dataset.Table("write_target")
	schema := bigquery.Schema{
		{Name: "id", Type: bigquery.IntegerFieldType, Required: true},
		{Name: "note", Type: bigquery.StringFieldType},
	}
	if err := table.Create(ctx, &bigquery.TableMetadata{Schema: schema}); err != nil {
		t.Fatalf("create table: %v", err)
	}

	// Build a proto descriptor matching the schema.
	int64Type := descriptorpb.FieldDescriptorProto_TYPE_INT64
	stringType := descriptorpb.FieldDescriptorProto_TYPE_STRING
	optional := descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL
	idNum := int32(1)
	noteNum := int32(2)
	idName := "id"
	noteName := "note"
	rowMsgName := "Row"
	desc := &descriptorpb.DescriptorProto{
		Name: &rowMsgName,
		Field: []*descriptorpb.FieldDescriptorProto{
			{Name: &idName, Number: &idNum, Type: &int64Type, Label: &optional},
			{Name: &noteName, Number: &noteNum, Type: &stringType, Label: &optional},
		},
	}

	// Compile into a runtime descriptor so we can build dynamicpb messages.
	fileName := "row.proto"
	filePkg := "bqlocal_test"
	syntaxProto2 := "proto2"
	fileProto := &descriptorpb.FileDescriptorProto{
		Name:        &fileName,
		Package:     &filePkg,
		Syntax:      &syntaxProto2,
		MessageType: []*descriptorpb.DescriptorProto{desc},
	}
	fileDesc, err := protodesc.NewFile(fileProto, nil)
	if err != nil {
		t.Fatalf("protodesc.NewFile: %v", err)
	}
	msgDesc := fileDesc.Messages().ByName(protoreflect.Name(rowMsgName))

	serialize := func(id int64, note string) []byte {
		m := dynamicpb.NewMessage(msgDesc)
		m.Set(msgDesc.Fields().ByName("id"), protoreflect.ValueOfInt64(id))
		m.Set(msgDesc.Fields().ByName("note"), protoreflect.ValueOfString(note))
		b, err := proto.Marshal(m)
		if err != nil {
			t.Fatalf("marshal row: %v", err)
		}
		return b
	}

	// Storage Write client over an insecure gRPC channel.
	conn, err := grpc.NewClient(emulatorGRPC, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}
	defer conn.Close()
	writeClient, err := storage.NewBigQueryWriteClient(
		ctx,
		option.WithGRPCConn(conn),
		option.WithoutAuthentication(),
	)
	if err != nil {
		t.Fatalf("NewBigQueryWriteClient: %v", err)
	}
	defer writeClient.Close()

	defaultStream := "projects/" + project + "/datasets/ds_storage_write/tables/write_target/streams/_default"

	bidi, err := writeClient.AppendRows(ctx)
	if err != nil {
		t.Fatalf("AppendRows: %v", err)
	}

	req := &storagepb.AppendRowsRequest{
		WriteStream: defaultStream,
		Rows: &storagepb.AppendRowsRequest_ProtoRows{
			ProtoRows: &storagepb.AppendRowsRequest_ProtoData{
				WriterSchema: &storagepb.ProtoSchema{ProtoDescriptor: desc},
				Rows: &storagepb.ProtoRows{SerializedRows: [][]byte{
					serialize(1, "alpha"),
					serialize(2, "beta"),
					serialize(3, "gamma"),
				}},
			},
		},
	}
	if err := bidi.Send(req); err != nil {
		t.Fatalf("bidi.Send: %v", err)
	}
	if err := bidi.CloseSend(); err != nil {
		t.Fatalf("bidi.CloseSend: %v", err)
	}

	responsesSeen := 0
	for {
		resp, err := bidi.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("bidi.Recv: %v", err)
		}
		if resp.GetError() != nil {
			t.Fatalf("AppendRows error: %v", resp.GetError())
		}
		if resp.GetWriteStream() != defaultStream {
			t.Fatalf("write_stream %q != %q", resp.GetWriteStream(), defaultStream)
		}
		responsesSeen++
	}
	if responsesSeen != 1 {
		t.Fatalf("expected exactly one response, got %d", responsesSeen)
	}

	// Verify rows landed via the REST query path.
	q := bq.Query("SELECT id, note FROM `" + project + ".ds_storage_write.write_target` ORDER BY id")
	it, err := q.Read(ctx)
	if err != nil {
		t.Fatalf("read query: %v", err)
	}
	type row struct {
		ID   int64
		Note string
	}
	var rows []row
	for {
		var r struct {
			ID   int64  `bigquery:"id"`
			Note string `bigquery:"note"`
		}
		err := it.Next(&r)
		if err == iterator.Done {
			break
		}
		if err != nil {
			t.Fatalf("it.Next: %v", err)
		}
		rows = append(rows, row{ID: r.ID, Note: r.Note})
	}
	if len(rows) != 3 {
		t.Fatalf("expected 3 rows, got %d: %+v", len(rows), rows)
	}
	expected := []row{{1, "alpha"}, {2, "beta"}, {3, "gamma"}}
	for i, want := range expected {
		if rows[i] != want {
			t.Fatalf("row %d: got %+v want %+v", i, rows[i], want)
		}
	}
}
