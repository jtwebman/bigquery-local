package local.bigquery;

import com.google.cloud.NoCredentials;
import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.BigQueryOptions;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.QueryJobConfiguration;
import com.google.cloud.bigquery.TableResult;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared harness for the Java client tests. Lazily spawns one emulator (and a
 * tiny in-memory GCS stub backing load/extract jobs) on first use, torn down
 * by a JVM shutdown hook. Mirrors the Go TestMain / Python session fixture.
 */
final class Emu {
  private static String url;
  private static Process process;
  private static HttpServer gcs;
  private static final Map<String, byte[]> gcsBytes = new ConcurrentHashMap<>();
  private static final Map<String, String> gcsContentType = new ConcurrentHashMap<>();

  private Emu() {}

  static synchronized String url() {
    if (url == null) {
      start();
    }
    return url;
  }

  private static void start() {
    try {
      startGcsStub();
      String gcsUrl = "http://127.0.0.1:" + gcs.getAddress().getPort();

      // surefire cwd = this module (test/clients/java); repo root is 3 up.
      Path repoRoot = Paths.get("").toAbsolutePath().getParent().getParent().getParent();
      ProcessBuilder pb =
          new ProcessBuilder(
              "node", "--conditions=src", "src/cli.ts", "--port=0", "--grpc-port=0",
              "--database=:memory:");
      pb.directory(repoRoot.toFile());
      pb.environment().put("STORAGE_EMULATOR_HOST", gcsUrl);
      pb.redirectErrorStream(true);
      process = pb.start();

      BufferedReader reader =
          new BufferedReader(
              new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
      Pattern listening = Pattern.compile("listening on (\\S+)");
      long deadline = System.currentTimeMillis() + 30_000;
      while (System.currentTimeMillis() < deadline) {
        String line = reader.readLine();
        if (line == null) {
          if (!process.isAlive()) {
            throw new IllegalStateException("emulator exited before listening");
          }
          continue;
        }
        Matcher m = listening.matcher(line);
        if (m.find()) {
          url = m.group(1);
          break;
        }
      }
      if (url == null) {
        throw new IllegalStateException("emulator did not print a listening URL within timeout");
      }
      Thread drain =
          new Thread(
              () -> {
                try {
                  while (reader.readLine() != null) {
                    // discard
                  }
                } catch (Exception ignored) {
                  // process exiting
                }
              });
      drain.setDaemon(true);
      drain.start();
      Runtime.getRuntime()
          .addShutdownHook(
              new Thread(
                  () -> {
                    process.destroyForcibly();
                    gcs.stop(0);
                  }));
    } catch (Exception e) {
      throw new IllegalStateException("failed to start emulator", e);
    }
  }

  // -------------------------------------------------------------------------
  // In-memory GCS stub (the subset of the GCS JSON API load/extract jobs use)
  // -------------------------------------------------------------------------

  private static final Pattern GCS_DOWNLOAD =
      Pattern.compile("^/storage/v1/b/([^/]+)/o/(.+)$");
  private static final Pattern GCS_UPLOAD = Pattern.compile("^/upload/storage/v1/b/([^/]+)/o$");

  private static void startGcsStub() throws Exception {
    gcs = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    gcs.createContext("/", Emu::handleGcs);
    gcs.start();
  }

  private static void handleGcs(HttpExchange ex) throws java.io.IOException {
    String path = ex.getRequestURI().getPath();
    Map<String, String> q = parseQuery(ex.getRequestURI().getRawQuery());
    if ("GET".equals(ex.getRequestMethod())) {
      Matcher m = GCS_DOWNLOAD.matcher(path);
      if (!m.matches()) {
        send(ex, 404, "application/json", "{}".getBytes(StandardCharsets.UTF_8));
        return;
      }
      String bucket = m.group(1);
      String name = URLDecoder.decode(m.group(2), StandardCharsets.UTF_8);
      String key = bucket + "::" + name;
      byte[] obj = gcsBytes.get(key);
      if (obj == null) {
        send(ex, 404, "application/json", "{\"error\":{\"code\":404}}".getBytes(StandardCharsets.UTF_8));
        return;
      }
      if ("media".equals(q.get("alt"))) {
        send(ex, 200, gcsContentType.getOrDefault(key, "application/octet-stream"), obj);
      } else {
        String json =
            String.format(
                "{\"name\":\"%s\",\"bucket\":\"%s\",\"size\":\"%d\",\"contentType\":\"%s\",\"updated\":\"2026-05-25T00:00:00.000Z\"}",
                name, bucket, obj.length, gcsContentType.getOrDefault(key, "application/octet-stream"));
        send(ex, 200, "application/json", json.getBytes(StandardCharsets.UTF_8));
      }
      return;
    }
    if ("POST".equals(ex.getRequestMethod())) {
      Matcher m = GCS_UPLOAD.matcher(path);
      String name = q.get("name");
      if (!m.matches() || name == null) {
        send(ex, 400, "application/json", "{}".getBytes(StandardCharsets.UTF_8));
        return;
      }
      String bucket = m.group(1);
      byte[] body = ex.getRequestBody().readAllBytes();
      String key = bucket + "::" + name;
      gcsBytes.put(key, body);
      String ct = ex.getRequestHeaders().getFirst("Content-Type");
      gcsContentType.put(key, ct != null ? ct : "application/octet-stream");
      String json =
          String.format("{\"name\":\"%s\",\"bucket\":\"%s\",\"size\":\"%d\"}", name, bucket, body.length);
      send(ex, 200, "application/json", json.getBytes(StandardCharsets.UTF_8));
      return;
    }
    send(ex, 404, "application/json", "{}".getBytes(StandardCharsets.UTF_8));
  }

  private static Map<String, String> parseQuery(String raw) {
    Map<String, String> out = new java.util.HashMap<>();
    if (raw == null) {
      return out;
    }
    for (String pair : raw.split("&")) {
      int eq = pair.indexOf('=');
      if (eq > 0) {
        out.put(
            URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8),
            URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
      }
    }
    return out;
  }

  private static void send(HttpExchange ex, int code, String contentType, byte[] body)
      throws java.io.IOException {
    ex.getResponseHeaders().set("Content-Type", contentType);
    ex.sendResponseHeaders(code, body.length);
    try (OutputStream os = ex.getResponseBody()) {
      os.write(body);
    }
  }

  /** Seed an object the emulator can load from `gs://bucket/name`. */
  static void gcsPut(String bucket, String name, byte[] body, String contentType) {
    url(); // ensure stub is up
    gcsBytes.put(bucket + "::" + name, body);
    gcsContentType.put(bucket + "::" + name, contentType);
  }

  /** Read back an object an extract job wrote, or null. */
  static byte[] gcsGet(String bucket, String name) {
    return gcsBytes.get(bucket + "::" + name);
  }

  // -------------------------------------------------------------------------
  // BigQuery client helpers
  // -------------------------------------------------------------------------

  static BigQuery client(String project) {
    return BigQueryOptions.newBuilder()
        .setProjectId(project)
        .setHost(url())
        .setCredentials(NoCredentials.getInstance())
        .build()
        .getService();
  }

  static String uniqueProject() {
    return "java-" + UUID.randomUUID().toString().substring(0, 8);
  }

  /** Run a query (or statement) and collect the result rows. */
  static List<FieldValueList> rows(BigQuery bq, String sql) throws Exception {
    return rows(bq, QueryJobConfiguration.newBuilder(sql).setUseLegacySql(false).build());
  }

  /** Run a prebuilt query config (e.g. with parameters) and collect the rows. */
  static List<FieldValueList> rows(BigQuery bq, QueryJobConfiguration cfg) throws Exception {
    TableResult result = bq.query(cfg);
    List<FieldValueList> out = new ArrayList<>();
    result.iterateAll().forEach(out::add);
    return out;
  }

  /** Raw GET against the emulator REST surface; returns the HTTP status. */
  static int httpGetStatus(String path) throws Exception {
    HttpResponse<String> resp =
        HttpClient.newHttpClient()
            .send(
                HttpRequest.newBuilder(URI.create(url() + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    return resp.statusCode();
  }
}
