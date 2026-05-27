"""
dbt-bigquery → bigquery-local shim.

`dbt-bigquery` has no profiles.yml option for a custom API endpoint or
anonymous credentials (see dbt-labs/dbt-bigquery#358), so it can't be pointed
at an emulator out of the box. This module — auto-imported by Python when its
directory is on PYTHONPATH — monkeypatches the BigQuery client so every
connection targets the emulator with anonymous credentials.

Enable it by setting two env vars and putting this file's directory on the path:

    export BIGQUERY_EMULATOR_HOST=http://localhost:9050
    export BIGQUERY_EMULATOR_PROJECT=my-project        # optional, defaults below
    export PYTHONPATH=/path/to/this/dir:$PYTHONPATH
    dbt run

It's a workaround, not a supported integration — revisit when #358 lands.
"""

import os

_host = os.environ.get("BIGQUERY_EMULATOR_HOST")
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

    # Force every BigQuery client at the emulator with anon creds, regardless of
    # how dbt passes its own args (it passes credentials positionally).
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
