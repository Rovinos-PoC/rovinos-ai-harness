# Environment diagnostics

`harness doctor` checks the local Node.js version, loaded configuration, configured secret
references, and data-directory write access. When `pii.presidio` is configured, it also checks the
analyzer's `/health` endpoint and reports `presidio_reachable` or `presidio_unreachable`. Checks
run sequentially with a five-second timeout each. A failed check produces exit code `1`; warnings
do not change the successful exit code.

Human output is a table containing each check's `id`, `status`, and `code`. With `--json`, the
command prints one array validated by `DoctorResultsSchema` from
`packages/schemas/src/cli/doctor.ts`. A check may include a safe `detail` code in its JSON result;
secret-resolution results use a sanitized reference name, never the resolved value or file path.
World-readable secret files resolve with a `warn` result and the `secret_file_permissions` code.

## Adding a check

Packages can register checks with `registerDoctorCheck` from `@harness/core`. Each check receives
the loaded configuration, environment, configured data directory, an abort signal, and a resolver
that reports success or failure without returning the secret value. A timed-out check has its
signal aborted; checks with asynchronous work should stop and clean up when their signal is aborted.

```ts
registerDoctorCheck({
  id: "service_ready",
  title: "Service readiness",
  async run(ctx) {
    return { status: "ok", code: "service_ready" };
  },
});
```

Store the check with the package that owns the dependency it validates. Later checks can cover
store connectivity, server reachability, Presidio, and sandbox availability without coupling the
core registry to those packages.
