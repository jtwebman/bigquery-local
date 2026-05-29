using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;

namespace BigQueryLocal.Tests;

/// <summary>
/// Shared emulator harness. Lazily spawns `node src/cli.ts` on first use,
/// captures both the HTTP and gRPC URLs from the banner, and tears down at
/// process exit. Mirrors the Java / Go / Python harnesses.
/// </summary>
internal static class Emulator
{
    private static readonly object _lock = new();
    private static Process? _process;
    private static string? _httpUrl;
    private static string? _grpcUrl;

    public static string HttpUrl
    {
        get
        {
            Ensure();
            return _httpUrl!;
        }
    }

    public static string GrpcUrl
    {
        get
        {
            Ensure();
            return _grpcUrl!;
        }
    }

    private static void Ensure()
    {
        lock (_lock)
        {
            if (_process is not null) return;

            var repoRoot = FindRepoRoot();
            var psi = new ProcessStartInfo("node")
            {
                ArgumentList =
                {
                    "--conditions=src",
                    "src/cli.ts",
                    "--port=0",
                    "--grpc-port=0",
                    "--database=:memory:",
                },
                WorkingDirectory = repoRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            _process = Process.Start(psi)
                ?? throw new InvalidOperationException("failed to start emulator");

            // Mirror stderr → stdout for visibility.
            _process.ErrorDataReceived += (_, e) => { /* drain */ };
            _process.BeginErrorReadLine();

            var httpRe = new Regex(@"listening on (http://\S+)");
            var grpcRe = new Regex(@"gRPC on (\S+)");
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (DateTime.UtcNow < deadline && (_httpUrl is null || _grpcUrl is null))
            {
                var line = _process.StandardOutput.ReadLine();
                if (line is null)
                {
                    if (_process.HasExited)
                        throw new InvalidOperationException("emulator exited before listening");
                    Thread.Sleep(50);
                    continue;
                }
                if (_httpUrl is null)
                {
                    var m = httpRe.Match(line);
                    if (m.Success) _httpUrl = m.Groups[1].Value;
                }
                if (_grpcUrl is null)
                {
                    var m = grpcRe.Match(line);
                    if (m.Success) _grpcUrl = m.Groups[1].Value;
                }
            }
            if (_httpUrl is null || _grpcUrl is null)
                throw new InvalidOperationException("emulator did not print HTTP+gRPC URLs");

            // Drain remaining stdout so the pipe doesn't fill.
            new Thread(() =>
            {
                try { while (_process.StandardOutput.ReadLine() is not null) { } }
                catch { /* shutdown race */ }
            }) { IsBackground = true }.Start();

            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
            {
                try
                {
                    if (_process is { HasExited: false })
                    {
                        _process.Kill();
                        _process.WaitForExit(5_000);
                    }
                }
                catch { /* best-effort */ }
            };
        }
    }

    private static string FindRepoRoot()
    {
        // Start from the test binary's directory and walk up looking for
        // package.json — the same trick the other client harnesses use.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json"))
                && Directory.Exists(Path.Combine(dir.FullName, "src")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new InvalidOperationException("could not locate repo root from " + AppContext.BaseDirectory);
    }
}
