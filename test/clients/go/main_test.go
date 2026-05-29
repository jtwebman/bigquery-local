// Package bqlocal_test runs the real `cloud.google.com/go/bigquery`
// client against the bigquery-local emulator binary.
//
// TestMain spawns:
//   - An in-process GCS stub speaking the subset of the GCS JSON API
//     that load + extract jobs use.
//   - The emulator: `node --conditions=src src/cli.ts --port=0 ...`,
//     with STORAGE_EMULATOR_HOST pointed at the stub.
//
// Both shut down at session end. The emulator's REST URL lives in
// `emulatorURL`, the GCS stub in `gcsStub`.
//
// Per-test isolation: each test calls `newClient(t)` which gives it a
// unique project id so per-test datasets don't collide.
package bqlocal_test

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/bigquery"
	"google.golang.org/api/option"
)

var (
	emulatorURL  string
	emulatorGRPC string // host:port, no scheme — for Storage Read/Write clients
	gcsStub      *gcsStubServer
)

// ----------------------------------------------------------------------------
// GCS stub
// ----------------------------------------------------------------------------

// gcsObject is one stored blob in the in-memory map.
type gcsObject struct {
	bytes       []byte
	contentType string
}

// gcsStubServer mimics the GCS JSON API surface the emulator's load +
// extract paths use:
//
//	GET  /storage/v1/b/{bucket}/o/{name}?alt={json,media}
//	POST /upload/storage/v1/b/{bucket}/o?uploadType=media&name=...
type gcsStubServer struct {
	url     string
	server  *http.Server
	mu      sync.Mutex
	objects map[string]gcsObject
}

func newGCSStub() (*gcsStubServer, error) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &gcsStubServer{
		url:     fmt.Sprintf("http://%s", lis.Addr().String()),
		objects: make(map[string]gcsObject),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handle)
	s.server = &http.Server{Handler: mux}
	go func() { _ = s.server.Serve(lis) }()
	return s, nil
}

var downloadPattern = regexp.MustCompile(`^/storage/v1/b/([^/]+)/o/(.+)$`)
var uploadPattern = regexp.MustCompile(`^/upload/storage/v1/b/([^/]+)/o$`)

func (s *gcsStubServer) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		m := downloadPattern.FindStringSubmatch(r.URL.Path)
		if m == nil {
			http.NotFound(w, r)
			return
		}
		bucket, name := m[1], m[2]
		// `name` is URL-encoded; canonical form preserves slashes.
		// http.Request.URL.Path is already decoded.
		s.mu.Lock()
		obj, ok := s.objects[bucket+"::"+name]
		s.mu.Unlock()
		if !ok {
			http.Error(w, `{"error":{"code":404}}`, http.StatusNotFound)
			return
		}
		alt := r.URL.Query().Get("alt")
		if alt == "" {
			alt = "json"
		}
		if alt == "json" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w,
				`{"name":%q,"bucket":%q,"size":%q,"contentType":%q,"updated":"2026-05-25T00:00:00.000Z"}`,
				name, bucket, fmt.Sprintf("%d", len(obj.bytes)), obj.contentType,
			)
			return
		}
		w.Header().Set("Content-Type", obj.contentType)
		_, _ = w.Write(obj.bytes)
		return
	}

	if r.Method == http.MethodPost {
		m := uploadPattern.FindStringSubmatch(r.URL.Path)
		if m == nil {
			http.NotFound(w, r)
			return
		}
		bucket := m[1]
		name := r.URL.Query().Get("name")
		if name == "" {
			http.Error(w, "missing name", http.StatusBadRequest)
			return
		}
		body := make([]byte, 0, 64*1024)
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Body.Read(buf)
			if n > 0 {
				body = append(body, buf[:n]...)
			}
			if err != nil {
				break
			}
		}
		ct := r.Header.Get("Content-Type")
		if ct == "" {
			ct = "application/octet-stream"
		}
		s.mu.Lock()
		s.objects[bucket+"::"+name] = gcsObject{bytes: body, contentType: ct}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"name":%q,"bucket":%q,"size":%q}`, name, bucket, fmt.Sprintf("%d", len(body)))
		return
	}
	http.NotFound(w, r)
}

func (s *gcsStubServer) put(bucket, name string, body []byte, contentType string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[bucket+"::"+name] = gcsObject{bytes: body, contentType: contentType}
}

func (s *gcsStubServer) get(bucket, name string) (gcsObject, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.objects[bucket+"::"+name]
	return o, ok
}

func (s *gcsStubServer) shutdown(ctx context.Context) {
	_ = s.server.Shutdown(ctx)
}

// ----------------------------------------------------------------------------
// Emulator subprocess
// ----------------------------------------------------------------------------

func repoRoot() (string, error) {
	// test/clients/go/<file>.go  →  parent's parent's parent.
	_, file, _, _ := runtime.Caller(0)
	return filepath.Abs(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func startEmulator(gcsURL string) (string, string, *exec.Cmd, error) {
	root, err := repoRoot()
	if err != nil {
		return "", "", nil, err
	}
	cmd := exec.Command(
		"node", "--conditions=src", "src/cli.ts",
		"--port=0", "--grpc-port=0", "--database=:memory:",
	)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "STORAGE_EMULATOR_HOST="+gcsURL)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", "", nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return "", "", nil, err
	}
	httpPat := regexp.MustCompile(`listening on (http://[^\s]+)`)
	grpcPat := regexp.MustCompile(`gRPC on ([^\s]+)`)
	scanner := bufio.NewScanner(stdout)
	deadline := time.Now().Add(30 * time.Second)
	var httpURL, grpcURL string
	for time.Now().Before(deadline) && (httpURL == "" || grpcURL == "") {
		if !scanner.Scan() {
			break
		}
		line := scanner.Text()
		if httpURL == "" {
			if m := httpPat.FindStringSubmatch(line); m != nil {
				httpURL = m[1]
			}
		}
		if grpcURL == "" {
			if m := grpcPat.FindStringSubmatch(line); m != nil {
				grpcURL = m[1]
			}
		}
	}
	if httpURL == "" || grpcURL == "" {
		_ = cmd.Process.Kill()
		return "", "", nil, fmt.Errorf("emulator did not print HTTP+gRPC URLs within timeout")
	}
	// Drain remaining stdout in the background so the pipe doesn't fill.
	go func() {
		for scanner.Scan() {
		}
	}()
	return httpURL, grpcURL, cmd, nil
}

// ----------------------------------------------------------------------------
// TestMain
// ----------------------------------------------------------------------------

func TestMain(m *testing.M) {
	stub, err := newGCSStub()
	if err != nil {
		fmt.Fprintf(os.Stderr, "starting GCS stub: %v\n", err)
		os.Exit(1)
	}
	gcsStub = stub
	url, grpcURL, cmd, err := startEmulator(stub.url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "starting emulator: %v\n", err)
		stub.shutdown(context.Background())
		os.Exit(1)
	}
	emulatorURL = url
	emulatorGRPC = grpcURL
	code := m.Run()
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	stub.shutdown(context.Background())
	os.Exit(code)
}

// ----------------------------------------------------------------------------
// Per-test client helper
// ----------------------------------------------------------------------------

var projectCounter struct {
	mu sync.Mutex
	n  int
}

func uniqueProject(t *testing.T) string {
	t.Helper()
	projectCounter.mu.Lock()
	projectCounter.n++
	n := projectCounter.n
	projectCounter.mu.Unlock()
	// Sanitize test name for project-id rules (lowercase, hyphens).
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'A' && r <= 'Z':
			return r + 32
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, t.Name())
	if len(safe) > 30 {
		safe = safe[:30]
	}
	return fmt.Sprintf("go-%s-%d", safe, n)
}

func newClient(t *testing.T) (*bigquery.Client, string) {
	t.Helper()
	project := uniqueProject(t)
	ctx := context.Background()
	client, err := bigquery.NewClient(
		ctx, project,
		option.WithEndpoint(emulatorURL),
		option.WithoutAuthentication(),
	)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, project
}
