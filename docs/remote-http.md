# Remote OmniFocus MCP

The HTTP server supports task, project, and tag management for remote MCP clients such as ChatGPT and Claude. It runs alongside OmniFocus Pro in a logged-in macOS session. The original stdio entrypoint remains available for existing local clients.

## Installation

Use Node 22 or later. Run `npm ci`, `npm run lint`, `npm test`, and `npm audit`. Start with `OMNIFOCUS_HTTP_CONFIG=/absolute/private/http.json npm run start:http`. The config must be owned by the running user with mode 600. The listener binds only to `127.0.0.1`, default port 8787. Keep credentials, config, write journals, and logs outside the checkout.

Example Cloudflare configuration:

```json
{
  "port": 8787,
  "access": "read-write",
  "ledgerDirectory": "/Users/example/.config/omnifocus-mcp/write-ledger",
  "auth": {
    "mode": "cloudflare",
    "issuer": "https://your-team.cloudflareaccess.com",
    "audience": "YOUR_ACCESS_APPLICATION_AUD",
    "allowedEmail": "you@example.com",
    "publicUrl": "https://focus.example.com/mcp"
  }
}
```

`access` defaults to `read-only`; write mode requires an absolute private ledger directory outside the repository. The ledger directory must be mode 700 and owned by the service user. Each record is mode 600. Do not delete or expire ledger records while retry protection is needed.

For loopback testing only, use `auth: { "mode": "local-bearer", "token": "<64 random lowercase hexadecimal characters>" }`. Every MCP request then requires that bearer token. Switch to Cloudflare mode before configuring public tunnel ingress.

## Tools

| Tool | Behavior |
| --- | --- |
| `query_tasks` | Filter by inbox/all/flagged, name, project/tag, status, or due-date range; optional custom perspective ID; notes opt-in |
| `get_task` | Read one exact task ID |
| `list_items` | Find project, tag, folder, or custom perspective IDs |
| `create_task` | Create in the inbox, a project, or a parent task, with dates, tags, note, flag, or estimate |
| `update_task` | Edit, move, complete, or reopen an exact task ID |
| `create_project`, `update_project` | Create/edit projects, notes, sequential mode, folder and status |
| `create_tag`, `update_tag` | Create/edit tags, parent relationships and status |
| `delete_item` | Delete an exact task/project/tag ID; matching `confirmId` required; nonempty items require `includeChildren=true` |
| `get_write_status` | Inspect a durable write outcome after a timeout or retry |

`list_items` includes folder parent IDs and tag status so clients can distinguish nested duplicate names and verify tag updates.

The first three tools are available in read-only mode. Write mode adds the other eight. No arbitrary-script tool or unlimited database dump is exposed. Bulk work uses bounded individual calls; a group of calls is not atomic.

Task reads default to 20 results, maximum 100, with a 100,000-character JSON budget. Names, tags and notes have explicit truncation flags; `hasMore` signals omitted matches. There is no pagination cursor. Dates require ISO 8601 with `Z` or a UTC offset. `null` clears nullable date/placement fields; omitted fields remain unchanged. Tag arrays replace existing tags, so read the current task before combining tag assignments.

`perspectiveId` reads the matching custom perspective through an open OmniFocus window's content tree. It temporarily selects the perspective and restores the previous one in `finally`, without expanding nodes or changing tasks. Results follow the content tree and its existing view filters; this is not a separate interpreter of archived perspective rules.

Task mutation tools reject project-root task IDs: use project tools to change a project. `get_task` can read a project-root task. Completing a repeating task can create its next occurrence. `allowRepeatingCompletion=true` explicitly permits that behavior, including repeating ancestors completed automatically by their children. Without opt-in those completion operations are rejected before mutations. Completion does not configure or alter recurrence rules.

## Write outcomes and retries

Every mutation requires a unique `idempotencyKey` for that user action. Reuse the same key and arguments after a network retry. The server saves a durable pending claim before automation and saves the validated read-back result before reporting success. Identical retries return that result; changed arguments under the same key are rejected.

If automation times out or crashes after claiming a key, the result is `OUTCOME_UNKNOWN`. The task may already have changed. Check `get_write_status` and inspect the database; do not generate a new key and automatically replay the action. Pending claims remain non-executable after restart. A known prevalidation failure is recorded as `not_applied`. A partial failure does not claim rollback. Read-back describes the resulting state; it is not a substitute for independent business-level verification.

The automation queue is shared by reads and writes: one active subprocess and at most eight pending operations per service process. Deadlines kill the subprocess after 20 seconds; combined stdout/stderr is capped at 1 MiB. Scripts use argument-based spawning and stdin. Client strings remain JSON data through both JavaScript interpreters. Output and ordinary logs never include generated scripts or credentials. HTTP logs contain only identity subject, status, and timing.

A single supervised HTTP process is the deployment model. Exclusive per-key journal claims also prevent duplicate execution by competing processes. The 50,000-record capacity cap is exact in that process; do not run concurrent service processes with different state directories against the same task database.

## Cloudflare and client setup

Create a separate self-hosted Access application covering the entire endpoint hostname. Restrict it to the exact verified identity, and prefer an MFA-capable sign-in. Enable Managed OAuth and dynamic client registration. Configure callback URIs from the clients. Claude's hosted callback is `https://claude.ai/api/mcp/auth_callback`; use ChatGPT's actual callback shown during setup. Avoid broad callback patterns and disable localhost/loopback clients unless intentionally needed.

Route only that hostname through a named Cloudflare Tunnel to `http://127.0.0.1:8787`, with a catch-all 404. Preserve the public Host header or configure `httpHostHeader` to the endpoint hostname. The origin verifies Cloudflare's signed `Cf-Access-Jwt-Assertion`, including issuer, audience, expiry, application token type, and exact email, using rotating JWKS. Cloudflare resolves the opaque OAuth bearer token at its edge; a bearer token by itself is not accepted by the origin.

The origin serves protected-resource metadata and emits an OAuth challenge. Access may replace these responses. Verify the actual public 401, `resource_metadata` URL, exact `/mcp` resource identifier, issuer, and S256 PKCE advertisement. Add the `/mcp` URL to each client and complete OAuth separately. Refresh client tool definitions after enabling writes; keep approval for mutating tools enabled. Client approval is useful, but server authentication, write-mode gating and validation are enforced independently.

## Operations and verification

Use a user LaunchAgent for the bridge, with an absolute Node path and explicit `OMNIFOCUS_HTTP_CONFIG`. Supervise the tunnel separately. Both depend on the logged-in GUI session needed by OmniFocus. Keep FileVault enabled and test reboot/login recovery separately. GET `/healthz` reports process health and configured read-only state, not database or sync health.

For an optional read-only readiness probe, set `OMNIFOCUS_READINESS_SOCKET` in the bridge LaunchAgent to an absolute Unix socket path outside the release directory, such as `/Users/example/.config/omnifocus-mcp/readiness.sock`. Its existing parent directory must be canonical, owned by the service user, and mode 700. The socket is mode 600 and is never exposed on the HTTP listener. Read its cached state with `curl --unix-socket /absolute/private/readiness.sock http://localhost/readyz`: status 200 means a successful probe is less than ten minutes old; status 503 means not ready. The response contains `ready`, `lastAttemptAt`, and `lastSuccessAt` (Unix milliseconds or null), with no task content. HTTP requests do not trigger probes.

The monitor performs a bounded canary task query on startup and every five minutes, skipping a busy automation queue. It shares the same serialized queue as client reads/writes, does not mutate tasks, and never restarts OmniFocus or replays writes. Probe failure marks cached readiness unavailable; unsafe or conflicting socket paths disable this optional monitor with a sanitized log message while leaving the MCP listener running. Keep any external check authenticated through the existing OAuth connector: a healthy local probe or an unauthenticated edge challenge alone cannot verify the full public route.

The [mini reliability operations](../scripts/mini-reliability/README.md) provide machine-specific GUI-login and log-retention agents plus a manual maintenance-policy helper. Review their fixed paths before use. They do not replace FileVault unlock or desktop login, suppress future setup screens, or provide an independent backup. Allow at least 30 seconds for bridge shutdown so its bounded automation work can drain. Retain the current write ledger when rolling back runtime code.

Deploy an exact Git revision from `main`, run `npm ci`, build/tests and audit, then point the LaunchAgent to that checkout. Retain the previous checkout/config for rollback. Do not copy secrets into the repository or commit a runtime ledger.

`npm test` uses fixtures and never modifies live OmniFocus. It covers escaping, strict MCP filters, custom perspective restoration, catalog identity context, bounds, queue serialization, HTTP admission/disconnect cleanup, permissions, auth failures, JWT claims, read-only tool rejection, write annotations, deletion validation, durable retries/conflicts, filesystem failure boundaries, simultaneous cross-process claims, SIGKILL recovery, fixture recovery manifests, private readiness failure/recovery and lifecycle, and operational log rotation with an open writer. These fixture tests do not establish actual OmniFocus recurrence, physical power-loss durability, reboot recovery, or long-lived OAuth refresh.

`npm run lint` uses pinned Oxlint correctness rules on the remote server, tests, and verification scripts, with type-aware unhandled-promise checks for remote TypeScript. The Node test runner owns top-level test-registration promises, so that rule is not applied to test files. `npm run typecheck` runs strict TypeScript checking without emitting files; `npm test` also type-checks as part of its build.

For an explicitly authorized live test only: `OMNIFOCUS_TEST_DIRECTORY=/absolute/private/verification node scripts/verify-write-fixture.mjs`. It creates uniquely named disposable projects/tags/tasks, reads back changes, checks replay, moves/completes/reopens tasks, and removes the items it created. A private manifest saves the run prefix and each exact operation, arguments, and stable key before execution, then records the result and created IDs. Unknown outcomes or manifest persistence failures stop further writes, including cascading cleanup. Keep that manifest and journal for manual reconciliation. No pre-existing item is selected for mutation. If the process is killed or creation returns an unknown outcome, inspect the unique fixture prefix and manifest before repeating or cleaning up.

References: [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), [Cloudflare JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Claude authentication](https://claude.com/docs/connectors/building/authentication), [OmniFocus Task API](https://omni-automation.com/omnifocus/task.html).
