"""
dbt-bigquery → bigquery-local shim.

`dbt-bigquery` has no profiles.yml option for a custom API endpoint or
anonymous credentials (see dbt-labs/dbt-bigquery#358), so it can't be pointed
at an emulator out of the box. This module — auto-imported by Python when its
directory is on PYTHONPATH — monkeypatches both the BigQuery REST client and
the BigQueryStorage gRPC client so every connection targets the emulator with
anonymous credentials.

Enable it by setting two-or-three env vars and putting this file's directory
on the path:

    export BIGQUERY_EMULATOR_HOST=http://localhost:9050   # REST
    export BIGQUERY_EMULATOR_GRPC_HOST=localhost:9060      # gRPC, optional
    export BIGQUERY_EMULATOR_PROJECT=my-project            # optional, defaults below
    export PYTHONPATH=/path/to/this/dir:$PYTHONPATH
    dbt run

When `BIGQUERY_EMULATOR_GRPC_HOST` is set, the shim patches
`google.cloud.bigquery_storage.BigQueryReadClient` (and the Write client) too
so dbt's Storage Read fast-path for SELECT result materialization routes
through the emulator. Without it the storage clients fall back to real
Google — which fails offline / under CI.

It's a workaround, not a supported integration — revisit when #358 lands.
"""

import os

_host = os.environ.get("BIGQUERY_EMULATOR_HOST")
_grpc_host = os.environ.get("BIGQUERY_EMULATOR_GRPC_HOST")

if _host:
    import inspect

    import google.auth
    from google.api_core.client_options import ClientOptions
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import bigquery

    _project = os.environ.get("BIGQUERY_EMULATOR_PROJECT", "dbt-emu")

    # dbt's `oauth` method calls google.auth.default() for ADC; hand back
    # anonymous creds so it never reaches Google's metadata server.
    google.auth.default = lambda *a, **k: (AnonymousCredentials(), _project)

    # Force every BigQuery REST client at the emulator with anon creds,
    # regardless of how dbt passes its own args (it passes credentials
    # positionally).
    _orig_init = bigquery.Client.__init__
    _sig = inspect.signature(_orig_init)

    def _patched_init(self, *args, **kwargs):
        bound = _sig.bind_partial(self, *args, **kwargs)
        call_kwargs = dict(bound.arguments)
        call_kwargs.pop("self", None)
        call_kwargs.pop("_http", None)  # mutually exclusive with credentials
        call_kwargs["credentials"] = AnonymousCredentials()
        call_kwargs["client_options"] = ClientOptions(api_endpoint=_host)
        _orig_init(self, **call_kwargs)

    bigquery.Client.__init__ = _patched_init


# Storage gRPC patch — only loads if both env vars are set AND the
# bigquery_storage package is installed (modern dbt-bigquery may or may
# not have it depending on extras).
if _host and _grpc_host:
    try:
        import grpc  # noqa: F401  (re-exported by gax)
        from google.api_core.client_options import ClientOptions as _StorageOpts
        from google.auth.credentials import AnonymousCredentials as _AnonCreds
        from google.cloud import bigquery_storage
    except ImportError:
        # No bigquery_storage installed → dbt isn't using Storage Read in
        # this environment, so nothing to patch.
        pass
    else:
        from grpc import ChannelCredentials, local_channel_credentials

        _insecure_channel_creds = local_channel_credentials()

        def _patch_storage_client(cls):
            _orig = cls.__init__
            _sig2 = inspect.signature(_orig)

            def _wrap(self, *args, **kwargs):
                bound = _sig2.bind_partial(self, *args, **kwargs)
                call_kwargs = dict(bound.arguments)
                call_kwargs.pop("self", None)
                call_kwargs["credentials"] = _AnonCreds()
                call_kwargs["client_options"] = _StorageOpts(
                    api_endpoint=_grpc_host,
                )
                # Some client lib versions accept a `transport=` argument
                # with insecure creds; others handle it via client_options.
                _orig(self, **call_kwargs)

            cls.__init__ = _wrap

        _patch_storage_client(bigquery_storage.BigQueryReadClient)
        # The Write client gets patched the same way — dbt rarely uses it,
        # but Apache Beam / Spark connectors do.
        if hasattr(bigquery_storage, "BigQueryWriteClient"):
            _patch_storage_client(bigquery_storage.BigQueryWriteClient)
