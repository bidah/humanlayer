# @humanlayer/cf-hosts (Worker `human-flare-hosts`)

Provisions **cloud daemon hosts**. Each host is a sandbox on Cloudflare Containers, Daytona or E2B.
It runs this fork's `humanlayer daemon launch` with a daemon token that the caller mints. The
service is stateless about ownership. The backend API owns the rows; this Worker only maps
`(provider, hostId)` to a provider sandbox.

Deployed at `https://human-flare-hosts.<WORKERS_SUBDOMAIN>.workers.dev` (or `HOSTS_ORIGIN`) by `bun run cloudflare:deploy`; see [CLOUDFLARE.md](../../CLOUDFLARE.md).

This README is the contract that the API integration codes against.

## Auth

Every `/v1/*` route requires `Authorization: Bearer <INTERNAL_SERVICE_SECRET>`. The comparison is
constant-time. The secret must be at least 16 characters. If the secret is missing or wrong, the
response is `401 {"error":{"code":"unauthorized",...}}`.

`/health` and `/cli/*` are public.

**Calling through a service binding.** A caller may reach this Worker through a Cloudflare service
binding instead of the public URL (the API and `human-flare-jobs` bind it as `HOSTS`). Address those
requests to the public origin (`https://human-flare-hosts.<subdomain>.workers.dev/v1/...`) anyway:
`POST /v1/hosts` and `.../bootstrap` tell the new host to download the CLI from the origin of the
request they received, so a made-up hostname would end up in the host's bootstrap and the download
would fail (`download of humanlayer CLI failed`).

## Data types

```ts
type Provider = 'cloudflare' | 'daytona' | 'e2b'
type HostSize = 'small' | 'medium' | 'large'

type HostState =
  | 'provisioning'  // provider is creating or starting the sandbox
  | 'bootstrapping' // sandbox is up and the bootstrap script is running
  | 'running'       // supervisor and `humanlayer daemon launch` process are up
  | 'degraded'      // bootstrap is done, but the daemon process is down (the supervisor restarts it)
  | 'failed'        // bootstrap failed; see `error`
  | 'stopped'       // sandbox exists but is not running
  | 'destroying'
  | 'not_found'

type BootstrapPhase =
  'none'|'starting'|'packages'|'user'|'cli'|'claude'|'git'|'daemon'|'running'|'failed'

interface HostInfo {
  provider: Provider
  hostId: string                  // lower-case UUID
  sandboxId: string | null        // Daytona sandbox id, E2B sandboxID, or the hostId on Cloudflare
  state: HostState
  providerState: string | null    // raw provider state, for debugging
  bootstrapPhase: BootstrapPhase | null
  supervisorRunning: boolean | null
  daemonRunning: boolean | null   // is a `humanlayer daemon launch` process alive now?
  error: string | null            // bootstrap error (redacted)
  createdAt: string | null        // ISO
  expiresAt: string | null        // ISO; the host is destroyed at this time
  size: HostSize | null
  cliVersion: string | null       // R2 artifact version that the host installed
}

interface HostSummary {
  provider: Provider
  hostId: string
  sandboxId: string | null
  providerState: string | null
  createdAt: string | null
  expiresAt: string | null
}
```

Errors always use the shape `{"error":{"code": string, "message": string, "details"?: unknown}}`.

| code | HTTP | meaning |
|---|---|---|
| `invalid_request` | 400 | zod validation failed (`details` = zod issues), bad JSON, or ttl over the provider cap |
| `unauthorized` | 401 | bad or missing bearer |
| `not_found` | 404 | no host for `(provider, hostId)`, or no such route |
| `not_configured` | 501 | provider credentials are missing (for example, `E2B_API_KEY` is unset) |
| `provider_error` | 502 / 503 | provider API failure, or no CLI artifact published (503) |
| `timeout` | 504 | the sandbox did not start in time |

## Endpoints

### `POST /v1/hosts` (create, idempotent per `(provider, hostId)`)

Request:

```jsonc
{
  "provider": "cloudflare",        // optional, default "cloudflare"
  "hostId": "<uuid>",              // required; must equal the hostId claim inside daemonToken
  "daemonToken": "<compact JWT>",  // required; RS256 {userId, organizationId, hostId, createdAt}
  "env": {                         // optional; UPPER_SNAKE keys, at most 64 entries, values up to 16 KiB
    "ANTHROPIC_API_KEY": "...",    //   or CLAUDE_CODE_OAUTH_TOKEN
    "GH_TOKEN": "...",             //   enables a github.com git credential helper and `gh`
    "OPENAI_API_KEY": "...",       //   anything else is passed through to the daemon
    "GIT_AUTHOR_NAME": "..."
  },
  "ttlMinutes": 1440,              // optional, 10..43200 (E2B: at most 1440), default 1440
  "size": "medium",                // optional; Daytona only (see Sizes)
  "cliVersion": "<r2 version>",    // optional; pins cli/<version>/; default is cli/latest.json
  "labels": { "orgId": "..." }     // optional; up to 16 entries, copied to provider labels/metadata
}
```

The bootstrap owns these `env` keys, and requests that set them are rejected:
`RIPTIDE_DAEMON_TOKEN HUMANLAYER_HOST_ID HUMANLAYER_HOST_PROVIDER HUMANLAYER_DISABLE_SELF_UPDATE
HUMANLAYER_CLAUDE_PATH IS_SANDBOX HOME USER PATH SHELL LD_PRELOAD LD_LIBRARY_PATH RIPTIDE_API_ORIGIN
RIPTIDE_SYNC_ORIGIN RIPTIDE_CLOUD_ORIGIN RIPTIDE_APP_ORIGIN RIPTIDE_DAEMON_LOAD_CREDS
RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY DAEMON_IDENTITY`.

Response: `201` when created, or `200` when a sandbox for that host already existed. In the second
case nothing is changed. Use `/bootstrap` to push a new token.

```jsonc
{ "created": true, "host": HostInfo, "timings": { "containerReadyMs": 874, "totalMs": 1092 } }
```

If `create` fails with a 5xx, a sandbox may still exist on Cloudflare or Daytona. E2B cleans up
after itself. Call `DELETE` for that `(provider, hostId)`; it is safe to call either way.

`create` returns after the sandbox is up and the bootstrap has *started*. The state is usually
`bootstrapping`. Poll `GET /v1/hosts/:provider/:hostId` until the state is `running` or `failed`.
That takes about 15 to 30 seconds.

### `GET /v1/hosts/:provider/:hostId` (status)

Returns `200 {"host": HostInfo}`, or `404 {"host": {... "state": "not_found"}}`. Status never wakes a
stopped Cloudflare container.

### `GET /v1/hosts/:provider/:hostId/logs?lines=200` (recent logs)

`lines` must be 1..2000 (default 200).

Returns `200 {"provider","hostId","bootstrap": string, "daemon": string}`. These are the tails of
`/opt/hlhost/logs/bootstrap.log` and `/opt/hlhost/logs/daemon.log`. The daemon log includes the
supervisor's start and exit lines. Before the logs leave the Worker, it redacts JWTs, `sk-ant-…`,
`sk-…`, GitHub, E2B and Daytona tokens, and `Authorization: Bearer` values. A missing host returns
404.

### `POST /v1/hosts/:provider/:hostId/bootstrap` (rotate credentials / re-run)

Request: `{"daemonToken": "<jwt>", "env": {...}, "cliVersion"?: "..."}`. This uploads a new
`host.env` and re-runs the idempotent bootstrap. If the credentials changed, the daemon restarts.
If `cliVersion` differs from the installed binary, the bootstrap installs the new binary.

Returns `200 {"host": HostInfo}`, or 404.

### `DELETE /v1/hosts/:provider/:hostId` (destroy)

Returns `200 {"provider","hostId","destroyed":true}`, or `404 {... "destroyed": false}` when there
was nothing to destroy.
- Cloudflare: SIGKILLs the container, cancels the watchdog, and deletes the stored inputs.
- Daytona and E2B: deletes the sandbox.

### `GET /v1/hosts[?provider=...]` (list)

Returns `200 {"hosts": HostSummary[], "errors": [{"provider","message"}]}`. Without `provider`, it
lists every configured provider, and a failure in one provider goes into `errors` instead of failing
the request. This call is cheap and does not exec in the sandboxes. Daytona can briefly still list a
host in `destroying` right after a DELETE.

### Public routes

| route | returns |
|---|---|
| `GET /health` | `{"ok":true,"providers":{"cloudflare":true,"daytona":true,"e2b":false}}` |
| `GET\|HEAD /cli/latest/humanlayer-<platform>` | latest binary; headers `x-checksum-sha256` and `x-humanlayer-cli-version` |
| `GET /cli/latest.json` | manifest |
| `GET /cli/<version>/humanlayer-<platform>` | immutable binary |
| `GET /cli/<version>/manifest.json` | immutable manifest |

`<platform>` is `linux-x64` (what hosts install), or any other platform the version was built for:
`linux-arm64`, `darwin-arm64`, `darwin-x64`, `win32-x64.exe` (listed in the manifest's `files`).

## What runs inside a host (all providers)

There is one shared script, `src/bootstrap.ts`. It is idempotent and holds a flock. It runs as root
and re-execs itself with `sudo -n` when it starts as another user.

1. Install `git procps curl ca-certificates util-linux passwd` through `apt-get` when any are
   missing. A glibc Debian or Ubuntu image is required.
2. Create the user `humanlayer` (home `/home/humanlayer`). Write
   `~/.humanlayer/riptide/host_id` = hostId.
3. Install `host.env` as `/opt/hlhost/host.env` (mode 0600, owner `humanlayer`) and delete the
   staged copy.
4. Download `/usr/local/bin/humanlayer` from this Worker. The sha256 is pinned to the manifest.
5. Install Claude Code with `https://claude.ai/install.sh` as `humanlayer`, into `~/.local/bin/claude`.
6. Configure git. When `GH_TOKEN` is set, the github.com credential helper reads `$GH_TOKEN` from
   the environment, so the token is never written to git config. The script also tries to install
   `gh`.
7. Start `/opt/hlhost/run-daemon.sh` with `setsid`, as `humanlayer`. The supervisor sources
   `host.env` and sets `HUMANLAYER_DISABLE_SELF_UPDATE=1 IS_SANDBOX=1 DISABLE_AUTOUPDATER=1
   HUMANLAYER_CLAUDE_PATH`. It then runs `humanlayer daemon launch` in a loop with backoff from
   2s to 60s, and resets the backoff after a run of 120s or more.

Secrets reach the sandbox only as an uploaded file. They are never placed in a URL, a command
line, provider env/metadata, or a log.

Phase and state can be read without root: `/opt/hlhost/phase`, `/opt/hlhost/error` and
`/opt/hlhost/logs/*`.

## Providers

| | cloudflare (default) | daytona | e2b (**unverified**) |
|---|---|---|---|
| Sandbox | Durable Object `HostSandbox` (one per hostId) + Container, built on `@cloudflare/sandbox` 0.12.14 | REST `app.daytona.io/api` | REST `api.e2b.app` + envd Connect RPC |
| Image | `docker.io/cloudflare/sandbox:0.12.14` (Ubuntu 22.04), pulled by reference | `FROM daytonaio/sandbox:0.11.0` (Debian 13), built by Daytona | template `E2B_TEMPLATE` (default `base`) |
| Size | fixed per deploy: `standard-2` (1 vCPU, 6 GiB, 12 GB); `size` is ignored | small 1/2GB, medium 2/4GB, large 4/8GB; 10 GB disk | set by the template; `size` is ignored |
| Idle | `keepAlive` + watchdog: never idles out | `autoStopInterval: 0` | E2B kills the sandbox at `timeout` |
| TTL | watchdog destroys at `expiresAt` (checks every 5 min) | Daytona `ttlMinutes` | `timeout = ttlMinutes*60` (cap 24h on Pro, 1h on Hobby) |
| Crash or platform stop | watchdog restarts the container and re-bootstraps from stored inputs | not handled (state becomes `stopped`) | not handled |
| Identification | DO name = hostId; registry DO for list | name `humanlayer-host-<hostId>`, labels `app=humanlayer, hostId` | metadata `app=humanlayer, hostId` |

The Cloudflare DO stores the rendered env file, including the daemon token and agent credentials, in
its own storage. It needs them to re-bootstrap after a platform restart. The stored inputs are
deleted on destroy.

## What the API must do to integrate

1. **Mint**: pick `hostId = crypto.randomUUID()`, then call
   `createSignedDaemonToken(userId, organizationId, hostId)`. Store a row with
   `{hostId, provider, organizationId, userId, sandboxId, expiresAt, status}` *before* calling create.
2. **Create**: call `POST /v1/hosts` with the token and the user's agent credentials (`env`).
   Then poll status, or let the first daemon heartbeat register the host as it does today.
3. **Destroy**: call `DELETE /v1/hosts/:provider/:hostId`. Then **revoke** the daemon token.
   Daemon tokens carry no `exp`, so revocation must happen API-side, for example with a
   denylist or a per-host `revokedAt` that `validateDaemonToken` checks. Mark the host row as
   deleted. A token that is not revoked keeps working wherever it leaked.
4. **Expiry**: hosts self-destruct at `expiresAt`. A periodic API job should reconcile
   `GET /v1/hosts` against its rows and revoke tokens for hosts that are gone.
5. **Rotate**: use `POST .../bootstrap` with a fresh token or fresh agent credentials.

## Operations

```bash
cd apps/cf-hosts
bun run test                      # unit tests (no Docker, no network, no env file)
bun run publish:cli               # build the linux-x64 CLI with this deployment baked in, verify, upload to R2
bun run publish:cli -- --all      # ... and every other platform
bun run build:cli -- --targets darwin-arm64   # local build only, in dist/cli/
bun run deploy                    # renders wrangler.jsonc from .env.cloudflare; no Docker: image is a registry reference
bun run scripts/smoke.ts --provider daytona     # e2e: sign token, create, poll, logs, destroy
```

The repo-level `bun run cloudflare:deploy` does all of this (and uploads the secrets
`INTERNAL_SERVICE_SECRET`, and `DAYTONA_API_KEY` / `E2B_API_KEY` when set).

`scripts/build-cli.ts` reads the origins, the auth service origin (`WORKOS_API_ORIGIN`, for
`humanlayer login`) and the client id from `.env.cloudflare`. It builds each binary under a scrubbed
environment that holds only those allowlisted build vars, and refuses to publish if any other value
from `.env.cloudflare` appears in a binary.

The R2 layout:
- `cli/<gitsha12>[-dirty.<ts>]/humanlayer-<platform>` and `manifest.json`
- `cli/latest.json`, written last

The manifest's `buildFingerprint` identifies the source tree and baked configuration;
`--upload --if-changed` (what the deploy script runs) skips the upload when `latest.json` already
has the same fingerprint.
