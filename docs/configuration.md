# Configuration

`@harness/config` loads YAML or JSON, validates it with the shared Zod fragments, and returns a deeply frozen `HarnessConfig`. Unknown keys are rejected. Validation errors identify paths and expected types without including submitted values.

## File selection and environment overrides

The loader selects a config file in this order:

1. The `configPath` option (the CLI's `--config` value).
2. `HARNESS_CONFIG`.
3. `harness.config.yaml` in the current working directory.

Environment values with the `HARNESS__` prefix override file values. Separate nested path segments with double underscores; segments are case-insensitive and underscore-separated names are converted to camel case. For example, `HARNESS__RUN__BUDGETS__MAXSTEPS=50` overrides `run.budgets.maxSteps` with the numeric value `50`. Overrides are merged into the file object before schema validation. Arrays cannot be overridden by environment variables.

`run.budgets.maxSteps` defaults to `200`, and `run.budgets.maxWallClockMs` defaults to `3600000`. Both must be positive integers. `run.budgets.maxCostUsd` is optional and must be a positive number when supplied. Reported model costs are accumulated as integer micro-dollars; responses without cost metadata do not count toward the cost budget. `run.budgets.countSuspendedTime` defaults to `false`; suspended intervals between `suspended` and `running` status events are excluded from the wall-clock budget unless it is set to `true`. The run start time and usage are recovered from the event log, so budgets do not reset on resume.

`run.subagents.maxDepth` defaults to `4` and cannot exceed that global ceiling. `run.subagents.maxChildrenPerRun` defaults to `8`, and `run.subagents.maxConcurrentChildren` defaults to `2`. Each spawned child inherits the parent's remaining step, cost, and absolute wall-clock deadline, further capped by its role budgets. Unfinished children reserve their allocated step and cost budgets, including while suspended; those limits and deadlines remain in force after resume. Parent usage includes terminal child usage. Cancelling a run cancels its unfinished child tree before recording the parent's cancellation.

`run.checkpointEveryEvents` defaults to `20` and must be a positive integer. The run loop writes a checkpoint when that many events have accrued since the previous checkpoint, and always writes one before returning a suspended run.

`run.shutdownGraceMs` defaults to `20000` and must be a positive integer. On SIGTERM or SIGINT, the run aborts in-flight work, suspends at a safe point, and writes a checkpoint before exiting with code 143 or 130. If the grace period expires first, the process attempts a best-effort checkpoint and exits with code 1. Set the container's `stop_grace_period` longer than this value so the container runtime does not terminate the process before graceful shutdown can finish.

Approval escalation notifications default to metadata-only log output. Configure
`policy.approvals.notifier` as `kind: log` or a webhook; webhook URLs must use
HTTPS, and their `secretRef` resolves to a bearer token through the configured
secret resolver. HTTP is accepted only for `localhost` when
`policy.approvals.allowInsecureLocalhost` is `true`. For example:

```yaml
policy:
  approvals:
    notifier:
      kind: webhook
      url: https://hooks.example.test/approval
      secretRef: env:APPROVAL_WEBHOOK_TOKEN
      timeoutMs: 5000
```

Approval argument reveal is disabled by default. To enable the app-only reveal
tool, set `controlPlane.allowReveal: true`. Every reveal requires a trusted app
host or human confirmation through elicitation. Reveal requests are limited to
pointers in the stored approval arguments and are audited at the `ui` boundary.

## Cassette recording

Set `HARNESS_CASSETTE_AUTO=0` to disable cassette auto mode. Record and auto modes require caller-provided storage-boundary sanitization and a final PII detector check before a response can be written.

Store, model, server, policy, PII, telemetry, and sandbox fragments are strict schemas owned by their respective packages. `telemetry.sentinel.minValueLength` defaults to `6` and controls the minimum length of vault values included in leak-sentinel scans; shorter values are counted and skipped. The sentinel is enabled by default; `telemetry.sentinel.enabled: false` is accepted only outside production. Configuration should contain secret references rather than secret values; secret resolution is covered by task 20.3.

The `store.dialect` is `sqlite` by default; select `postgres` and provide `store.connectionString` as a secret reference for the runtime and the store-management commands (both use the same configured store):

```yaml
store:
  dialect: postgres
  connectionString: env:HARNESS_STORE_URL
  retention:
    completedRunsDays: 30
    failedRunsDays: 60
```

The Postgres connection URL is resolved only when a store command needs it and is never printed.

The vault remains a local SQLite `vault.db` under the resolved data directory, even when
`store.dialect` is `postgres`. Separate runtime instances therefore do not share vault mappings;
the Postgres vault adapter is not wired yet (12.9, #140).

Run retention is opt-in under `store.retention`. When configured, provide positive `completedRunsDays` and `failedRunsDays`; cancelled runs use the failed-run window. Snapshot pruning is configured separately through the store adapter's `snapshotKeep` option (default `5`) and runs on each snapshot write. `harness store purge` supports dry runs and purges corresponding vault mappings.

Vault entries are retained for seven days after a run reaches a terminal status by default. Override the grace period with `vault.purgeAfterDays`; `harness store purge` removes mappings immediately for deleted runs and also purges expired terminal-run mappings during the same job. The event content may still contain tokens after a vault-only purge, but detokenization returns `undefined`. SQLite securely deletes rows; after a large purge, stop writers and run `VACUUM` separately to reclaim pages and remove remnants from the database file.

```yaml
vault:
  purgeAfterDays: 14
```

Configure `sandbox.runner` to use the isolated runner instead of the development-only in-process backend. Its URL must be an HTTP(S) origin, and `token` must be a secret reference:

```yaml
sandbox:
  runner:
    url: http://sandbox-runner:8080
    token: env:SANDBOX_RUNNER_TOKEN
```

The runner is intended for the internal Compose `sandbox` network; do not publish its port. Its Compose launcher retains `SETUID`/`SETGID` and the capability needed to clear child capability sets, so the server runs as `10002:10002` and can start each command with a separate uid/gid and all capability sets cleared. The server retains only those capabilities; sandboxed commands have empty inheritable, permitted, effective, bounding, and ambient sets, cannot change uid or gid, and have no supplementary groups. `no-new-privileges` remains enabled.

The sandbox Compose profile requires `SANDBOX_RUNNER_TOKEN`; provide it through the environment using your secret manager. The Compose service defaults the variable to empty so rendering or starting other profiles does not require a sandbox token, but the runner validates it (at least 32 bytes) and exits with `sandbox_runner_config_invalid` if it is missing or too short. The server removes a valid token from its environment at startup. The runner deliberately avoids a mounted token file because some container hosts, including Colima and Docker Desktop on macOS, do not enforce Unix permissions on bind-mounted files. Commands run under a different uid with no capabilities, receive only an explicit sanitized environment, and cannot read the server's `/proc` environment; integration tests also check that the token is absent from `/run`, `/app`, and the workspace.

Render and start Compose from the repository root with the collector version file:

```sh
SANDBOX_RUNNER_TOKEN="$(cat /secure/sandbox-runner-token)" \
  docker compose --env-file infra/collector/VERSION \
  --file infra/compose/docker-compose.yml --profile sandbox up --detach --build
```

`limits.outputBytes` also limits the maximum size of any file written by a command through its file-size resource limit; this coupling remains until task 19.5 adds per-run workspace quotas. The runner's per-run workspace isolation is also deferred to task 19.5.

`core.createRuntime` constructs one backend from `sandbox`: a `RemoteSandboxBackend` when `runner` is configured, resolving its token through the supplied `secretResolver`, or the development-only `InProcessBackend` otherwise. The CLI supplies its config secret resolver automatically. Local execution does not enforce network, filesystem, CPU, memory, or process-count isolation and refuses production startup unless `sandbox.allowUnsafeInProcess` is explicitly enabled.

Before each checkpoint, the runtime archives the run workspace under `<dataDir>/snapshots/<runId>`; `.harness/tmp` is excluded. The five latest workspace archives are retained with their checkpoint records and removed when the run is purged. On resume, a missing workspace is restored from the latest checkpoint. Set `sandbox.restoreOnResume: true` to restore even when a workspace already exists. Snapshots preserve whatever the workspace contains: tool offload data is tokenized before it reaches the workspace, but user-uploaded files remain the operator's responsibility. To encrypt snapshot files at rest with AES-GCM, set `sandbox.snapshotEncryption: true` and configure durable keys under `keys`; without encryption, snapshot archives are stored as ordinary files.

Unencrypted snapshot creation and restore verification stream archive data. Encrypted creation is an exception to the no-full-buffer guarantee: the AES-GCM API accepts a `Buffer`, so the compressed archive must be materialized before encryption.

The runtime exposes `sandboxBackend`. Applications can compose sandbox-backed tool ports with `RuntimeOverrides.createTool(backend)`; an explicit `tool` override takes precedence. This does not automatically register workspace or web tools. Tool adapters must keep the existing policy, approval, PII, and output-offloading boundaries. `RuntimeOverrides.sandboxBackend` replaces the backend for tests or embedding; the runtime owns its optional `close()` hook, including cleanup after setup failure. Closing the runtime also releases storage and keys if backend cleanup fails. The lower-level `createSandboxBackend(sandboxConfig, deps)` factory is exported by `@harness/sandbox`.

### Sandbox egress

Runner egress is denied unless an exact destination allowlist is configured. Each entry pairs one host with one or more ports; wildcards, private IP literals, and destinations resolving to loopback, link-local/metadata, private/shared, special-use, unique-local/site-local/discard-only, Teredo, or multicast ranges are rejected by the proxy, including private IPv4 addresses embedded in NAT64 and 6to4 IPv6 addresses.

```yaml
sandbox:
  egress:
    allow:
      - host: api.example.com
        ports: [443]
```

The sandbox Compose profile remains offline by default. `yarn compose:sandbox` reads `sandbox.egress.allow`, serializes it as `SANDBOX_EGRESS_ALLOW`, and adds the egress overlay and profile only when the list is non-empty. The overlay connects the runner to the internal proxy-only network; exec children receive the proxy variables without `NO_PROXY` bypasses. The runner has no external network attachment, so direct connections do not use the proxy's egress route. See [Sandbox egress](sandbox-egress.md) for the complete setup and security behavior.

A non-empty allowlist requires `sandbox.runner`; the factory rejects local fallback with `sandbox_runner_config_invalid`. Point `sandbox.runner.url` at the runner deployed by `yarn compose:sandbox` using the **same configuration**, including its egress overlay. Runtime configuration does not provision or inspect the runner's network topology; the operator must maintain this pairing.

Key versions are configured under `keys`. Each key must be a base64-encoded 32-byte secret reference. Keep old versions configured while stored content still uses them; new content uses `currentKeyId`.

```yaml
keys:
  currentKeyId: primary
  keys:
    - id: primary
      secret: env:HARNESS_PRIMARY_KEY
    - id: previous
      secret: file:/run/secrets/harness-previous-key
```

Generate a key with `harness keys generate` and place the output in an environment variable or secret store. The generated key is shown only once and is never written to a file.

## Tool policy

`policy.file` selects the YAML or JSON policy document used for tool calls. If
it is omitted, the runtime uses a built-in deny-all policy: every tool call is
denied. `harness doctor` warns with `policy_default_deny` when no policy file
is configured.

For example, configure a policy file alongside `harness.config.yaml`:

```yaml
policy:
  file: ./policy.yaml
```

The smallest useful allow policy is explicit about the tool it permits; replace
`my.read_only_tool` with an actual tool ID:

```yaml
version: 1
defaultDecision: deny
rules:
  - id: allow_read_only
    match:
      tools:
        - my.read_only_tool
    decision: allow
    reason: read_only_operation
```

See [Policy documents](./policy.md) for matching and tokenized-argument details.

Role configuration is a list of role definitions used to override the built-in
`planner`, `worker`, `judge`, and `summarizer` roles. See [Model roles](./roles.md)
for routing, tool, prompt, budget, context-strategy, and result-schema behavior.

`models.enforcement.maxRepairs` defaults to `2` and limits structured-output repair calls after an invalid model response. When the limit is exhausted, the gateway throws `model_output_invalid` with the final issue paths only.

## PII detectors and custom identifiers

`@harness/pii` exports synchronous detectors for email, phone, credit cards,
IBANs, IPv4/IPv6, AWS/GitHub keys, JWT-shaped strings, private-key opening
markers, and URL credentials. Credit cards require Luhn validation; IBANs
require a known country length and mod-97 validation. Detection is imperfect:
these are simplified formats, not comprehensive coverage of sensitive text.
JWT detection checks shape, not signature or authenticity. Private-key detection
marks the opening header, not the entire PEM body.

Detector results contain only entity codes, confidence, detector IDs, and
UTF-16 offsets (`start` inclusive, `end` exclusive). Slice the original text
with these offsets; do not convert them to Unicode code-point offsets.
`resolveOverlaps` returns sorted, non-overlapping ranges, preferring length,
then confidence, then lexically lower detector ID. Overlap chains are resolved
in start order against the last retained range; discarded ranges are not restored.

No national-ID patterns are built in. Configure an application-specific
custom entry, then compile it once with `createCustomDetector`. For example,
this synthetic format can be replaced with the bounded format appropriate
to your jurisdiction:

```yaml
pii:
  custom:
    - name: national_id_example
      pattern: '\bID-\d{8}\b'
```

The resulting entity code is `custom_national_id_example`; select that code
in PII policy rules. Custom matches preserve the exact original substring.
Optional `flags` supports `i`, `m`, `s`, and `u`; global Unicode scanning is
always enabled. Optional `validator` is `luhn` or `mod97` (IBAN-style rotation
of the first four characters).

Tool arguments remain tokenized unless a `pii.detokenize` entry explicitly
allows the destination tool and argument pointers. JSON Pointers use RFC 6901
escaping; a `*` segment selects array elements only. Unresolvable tokens fail
closed by default; `onUnresolvable: leave` preserves their token text instead.
Every resolution is audited with entity types and counts, not values. For example:

```yaml
pii:
  detokenize:
    - toolId: mail.send
      args:
        - /to
        - /attachments/*/name
      onUnresolvable: fail
```

The `*` segment traverses arrays only; for example, `/headers/*` does nothing
when `headers` is an object.

The conservative safety screen rejects unbounded quantifiers, quantified
groups, alternation, look-around assertions, backreferences, and Unicode property escapes.
It permits fixed atom repetitions up to 256 and at most one optional or
variable bounded repetition per pattern. Patterns are limited to 1024
characters. Rewrite rejected expressions using fixed-width atoms rather than
disabling the screen. Unsafe patterns fail with `pii_pattern_unsafe`; invalid
configuration or regex syntax fails with `pii_pattern_invalid`. Errors never
contain the submitted pattern or detected value.

See [Secret references](./secrets.md) for environment, file, and Key Vault reference forms and resolver behavior.

## PII tokenization

Runtime tool and storage boundaries are protected by default. Set
`pii.enabled: false` only for non-production development or testing; runtime
startup rejects that setting when `NODE_ENV=production`.

`Tokenizer` applies policy before writing detected values to the vault. JSON
string values are processed without changing structure. Keys remain unchanged:
detected PII in a key with `tokenize`, `redact`, or `block` policy fails the
operation with `pii_key_contains_pii` and per-type counts only, before vault
writes. Keys whose detections are explicitly allowed pass through unchanged.
JSON is limited to depth 64, 2 MiB of serialized UTF-8, and 1,024 string
values and object keys per input.

Tokens are run-scoped. Independent runs may use the same token string; resolve
each token only with its owning run ID. Existing tokens are not scanned again.
Action summaries use policy verbs; convert them with
`toPiiActionEventPayload` before recording canonical `pii_action` events.

## PII tool boundary composition

Task 13.7 adds `PiiToolPort` with structural tool ports (no reverse dependency on core).
Pass an already composed tool override to `createRuntime`:
`Offloading( Pii( Policy( Tools ) ) )`. The runtime does not automatically install
PII protection. Future policy decorators decide on tokenized arguments during
`prepare`, before `PiiToolPort.execute` resolves the configured argument pointers.
Policy authorization must not inspect the raw argument copy passed to execution.

Preparation runs before the durable model response and tool intent. Provider blobs
are omitted when preparation is enabled because opaque blobs can duplicate tool
arguments. Preparation failure records null arguments and a denied tool result;
failed calls are excluded from durable model-response recovery input. Input and
output summaries go through `RunRecorder`. Results are tokenized before previews,
files, or events are written. Detector coverage is not a complete detection guarantee.

Binary execution results use `binary: true` and a JSON numeric byte array validated
by `ToolBinaryPayloadSchema` (integers from 0 through 255). Only this representation
bypasses tokenization; flagged text or objects fail with `pii_input_invalid`.
The outer offloader always offloads binary output, even below its configured
threshold, with an empty preview. Oversized unflagged output still fails with
`pii_input_too_large`. Binary tools must use the composed outer offloader.

Canary checklist for this boundary: integration tests cover every recorded event
(including model responses and checkpoints), allowlisted raw execution, both
boundary summaries, blocked input, detector/vault failures, tokenized offload
files and previews, oversized text rejection, validated binary offloading without
previews, rejected textual binary flags, and an unprotected negative control.
