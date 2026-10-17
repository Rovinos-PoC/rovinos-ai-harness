# Sandbox workspace layout

The `harness-workspaces` volume is mounted at `/workspaces` in the sandbox
runner. Each run has a separate directory:

```text
/workspaces/<runId>/
├── project/             command working directory
└── .harness/
    ├── offload/         large tool results
    └── tmp/             run-scoped temporary files
```

The volume root is runner-owned (uid `10002`, gid `10003`) and mode `0750`, so
commands cannot create shared artifacts or hard links outside their run
directory. A run's top-level directory is mode `02750`; `project/`, `offload/`,
and `tmp/` use `02770`, while `.harness/` is mode `0750` so commands cannot
replace its trusted children. The setgid bit keeps newly created entries in
the shared group. The deployment must configure the harness service (uid
`10001`) and runner (uid `10002`) with the common gid `10003`. Commands run as
uid/gid `10003`. Only the runner creates, activates, and locks run directories;
the harness accesses offloads through the shared group and does not change
directory modes. The runner locks a run's top-level directory to mode `0700`
when its lease is released or expires.

The authenticated `POST /lease` endpoint explicitly reserves one run ID;
another run receives HTTP `409` with code `sandbox_busy`. Normal `/exec`
requests acquire an execution-scoped lease and release it after the process
group exits, allowing subagents with distinct run IDs to execute between
parent commands. An explicit lease remains pinned until `POST /release` or
expiry. Expiry cannot unlock a workspace while its process group is still
running. Leases expire after ten minutes by default. On runner startup, all
persisted run directories are sealed before the first lease is admitted.

Workspace paths are relative to the run's `project/` directory. The resolver
rejects absolute paths, NUL bytes, traversal segments, overlong paths, and
symlinks. Offloads are direct files in `.harness/offload/`; nested paths are
rejected so commands cannot replace an ancestor during file operations.
Offloaded files are limited to 10 MiB each and 500 MiB across the run by
default. Quota accounting includes the whole run directory and is recounted
periodically.

When a run is activated, the runner clears its `.harness/tmp` and `/tmp`
entries as the command execution uid, which can remove private command-owned
trees. Commands receive an absolute, run-specific `.harness/tmp` as `TMPDIR`.
The runner container also mounts `/tmp` as an ephemeral tmpfs. The harness does
not execute files from the workspace.

## File tools

The built-in `fs.read`, `fs.write`, `fs.edit`, `fs.list`, and `fs.search` tools
operate on paths relative to `project/`; they do not accept shell commands.
Every requested path passes through the workspace resolver, which rejects
absolute paths, traversal, and symlinks. The `.harness/` tree is not accessible
through these tools; use `read_offloaded` for offloaded output.

`fs.read` returns UTF-8 text in ranges of at most 256 KiB. Binary files return
only `{ binary: true, bytes }`. Writes accept at most 1 MiB of UTF-8 text;
`create` requires a missing path and `overwrite` requires an existing regular
file. Edits apply 1–20 exact-text replacements, each of which must occur once;
their combined old/new text is limited to 4 MiB. `/fs/<operation>` requests
allow up to 32 MiB of JSON transport to accommodate escaping.
An optional `expectedSha256` checks the prior bytes (the SHA-256 of empty bytes
represents a missing path for `create`). A retry after a successful preconditioned
write or edit fails with `precondition_failed`; unchanged output is rejected so
the original precondition cannot be reused.

`fs.list` is limited to depth 3 and 1,000 entries. `fs.search` returns at most
200 text-line matches and scans no more than 10 MiB or 1,000 files per request;
only the first 2,048 characters of each line are matched. Regex queries pass
the shared conservative ReDoS screen. File size and run quota failures use
`workspace_quota_exceeded`. The existing 10 MiB per-file and 500 MiB per-run
workspace limits apply to file reads and mutations. File results are returned through the runtime's usual PII
and output-offloading decorators. Read, list, and search are idempotent;
write and edit are advertised as idempotent only when they include
`expectedSha256`.

## Assumptions and known gaps

The shared group and volume permissions must be preserved by the deployment's
volume driver. The remote runner is the isolation boundary; the explicitly
development-only in-process backend scopes its working directory but does not
provide operating-system filesystem isolation from arbitrary absolute paths
used by a command.

Atomic replacements write and sync a temporary sibling, then compare the
target's device, inode, size, and modification time immediately before rename.
Rename requires write permission on the target's parent directory; when that
permission is unavailable, the operation may fail without replacing the target.
This narrows but cannot eliminate the final stat-to-rename race or make parent
path resolution descriptor-relative. Runner leases serialize normal `exec` and
file-tool requests. Runner dispatch also serializes `fetch`, `exec`, file
operations, and lease transitions so none overlap a process-wide credential
switch. Deployments and snapshot/restore code must not mutate an active workspace
through another process. Quotas are checked during file mutations, not
continuously enforced against arbitrary changes made by commands or external
volume writers.
