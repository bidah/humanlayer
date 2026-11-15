# Running HumanLayer on Cloudflare

This fork runs the HumanLayer backend, web apps and docs entirely on Cloudflare (Workers,
Durable Objects, Containers, Hyperdrive, KV, R2, D1, Queues, Cron Triggers) plus one external
Postgres 18 database. Upstream HumanLayer Cloud runs on AWS; see
[Self-hosting in the README](README.md#self-hosting) for that path.

This document covers what the fork changes, how to deploy it to your own Cloudflare account, how
to operate it, and what does not work. Statements marked **(not verified)** describe steps that
were not run end to end while this guide was written.

## Contents

- [What this fork changes, and why](#what-this-fork-changes-and-why)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [First deploy](#first-deploy)
- [Creating the first user and organization](#creating-the-first-user-and-organization)
- [The env file](#the-env-file)
- [How configuration reaches the Workers](#how-configuration-reaches-the-workers)
- [Cloud hosts](#cloud-hosts)
- [The CLI](#the-cli)
- [Day-two operations](#day-two-operations)
- [Switching to real WorkOS](#switching-to-real-workos)
- [Enabling Stripe billing](#enabling-stripe-billing)
- [Known limitations](#known-limitations)

## What this fork changes, and why

Upstream deploys HumanLayer to AWS with Pulumi: ECS Fargate services, Lambdas, RDS, MemoryDB,
S3, CloudFront, Secrets Manager, and WorkOS as the identity provider. Standing that up takes an AWS organization,
a WorkOS tenant and Docker image builds. This fork replaces each piece with a Cloudflare product,
so one command deploys the stack to one Cloudflare account, with no Docker anywhere.

The changes are additive. The Node/AWS entry points of the API and the sync proxy are unchanged;
the Worker builds use separate entry files (`src/worker.ts`) and build-time aliases for Node-only
dependencies. New packages hold the Cloudflare-only services:

| Package | Worker | Purpose |
|---|---|---|
| `apps/riptide-api` | `humanlayer-api` | The oRPC/Hono API, as a Worker (`src/worker.ts`) |
| `apps/riptide-electric-proxy` | `humanlayer-sync` | Auth proxy for Electric and Durable Streams, as a Worker |
| `apps/cf-durable-streams` | `humanlayer-streams` | The Durable Streams protocol on SQLite-backed Durable Objects |
| `apps/cf-electric` | `humanlayer-electric` | Electric SQL as a single Cloudflare Container |
| `apps/cf-jobs` | `humanlayer-jobs` | Cron Triggers: stale-daemon sweeper, DB maintenance, cloud host reconcile |
| `apps/cf-auth` | `humanlayer-auth` | A WorkOS-compatible auth service on D1 (see its [README](apps/cf-auth/README.md)) |
| `apps/cf-hosts` | `humanlayer-hosts` | Starts daemon hosts in cloud sandboxes; serves the CLI binaries (see its [README](apps/cf-hosts/README.md)) |
| `apps/riptide-ui` | `humanlayer-app` | The web app, as static assets |
| `apps/riptide-cloud` | `humanlayer-cloud` | The cloud site (sign-in, organizations), as static assets |
| `apps/docs` | `humanlayer-docs` | The docs site, as static assets |

The deploy tooling lives in `scripts/cloudflare/`:

- `deploy.ts`: stands the stack up from nothing, or updates it (`bun run cloudflare:deploy`).
- `config.ts`: reads `.env.cloudflare`, derives the origins, renders each Worker's config.
- `wrangler.ts`: runs wrangler for one package against its rendered config (used by the package scripts).
- `e2e/`: end-to-end checks against a deployment.

## Architecture

| Upstream (AWS) | This fork (Cloudflare) |
|---|---|
| `riptide-api` on ECS Fargate | Worker `humanlayer-api`, placed next to the database (`PLACEMENT_REGION`) |
| RDS Postgres | Any Postgres 18 with logical replication (for example Neon), reached through Hyperdrive `humanlayer-db` (Electric and migrations connect directly) |
| MemoryDB (Redis) | KV namespace `humanlayer-billing-cache` |
| S3 artifacts bucket, presigned URLs | R2 bucket `humanlayer-artifacts`, URLs signed by the API (`ARTIFACT_URL_SIGNING_SECRET`) |
| Singleton Electric on Fargate (ephemeral storage) | Worker `humanlayer-electric` + one Cloudflare Container (`electricsql/electric` image), ephemeral disk |
| `riptide-electric-proxy` on ECS | Worker `humanlayer-sync`, reaching Electric and Streams through service bindings |
| Singleton Rust durable streams server on Fargate behind an internal ALB | Worker `humanlayer-streams` on SQLite-backed Durable Objects |
| Stale-daemon sweeper Lambda + EventBridge schedule | Worker `humanlayer-jobs`, cron `* * * * *` |
| Database maintenance Lambda | Worker `humanlayer-jobs`, cron `17 4 * * *` |
| Migrator Lambda run on deploy | `drizzle-kit migrate` run by the deploy script |
| Post-response background work inside the API process | Queue `humanlayer-background` (+ dead-letter queue), consumed by `humanlayer-api` |
| Secrets Manager | Worker secrets, uploaded from `.env.cloudflare` by the deploy script |
| WorkOS (AuthKit, user management) | Worker `humanlayer-auth` on D1 `humanlayer-auth`, WorkOS-compatible; real WorkOS stays a config switch |
| S3 + CloudFront for `riptide-ui` and `riptide-cloud` | Workers Static Assets (`humanlayer-app`, `humanlayer-cloud`, and `humanlayer-docs` for the docs site), headers in `_headers` |
| Route53, ACM certificates | `workers.dev` subdomain (custom domains: set the `*_ORIGIN` keys and add the domains to the Workers yourself) |
| updater-server (desktop app updates) | Not ported |
| (no equivalent) | Worker `humanlayer-hosts`: daemon hosts on Cloudflare Containers, Daytona or E2B |
| Sentry | Not wired up on Workers (the calls are no-ops) |

Service bindings: `humanlayer-api` binds `humanlayer-streams` and `humanlayer-hosts`;
`humanlayer-sync` binds `humanlayer-electric` and `humanlayer-streams`; `humanlayer-jobs` binds
`humanlayer-hosts`. `humanlayer-streams` and `humanlayer-electric` have no public URL. The public
Workers are served at `https://<worker>.<WORKERS_SUBDOMAIN>.workers.dev` unless you override an
origin.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan, with **Containers** available (Electric and
  the Cloudflare cloud host provider run in Containers), and a `workers.dev` subdomain (shown in
  the dashboard under Workers & Pages; you choose it the first time you open that page).
- A **Postgres 18** database with **logical replication** enabled (`wal_level = logical`) and a
  direct (non-pooled) connection URL. On Neon: create a project on Postgres 18, then enable
  *Logical Replication* in the project settings. The deploy script checks the version and
  `wal_level` and stops if either is wrong.
- **bun** (`packageManager` in `package.json` names the version the repo is developed with), and
  `bun install` run at the repo root.
- **wrangler** logged in to the account: `node_modules/.bin/wrangler login` (the repo pins
  wrangler; use that binary, not a global one).
- No Docker. Container images are pulled by reference from Docker Hub
  (`electricsql/electric`, `cloudflare/sandbox`), and the CLI is cross-compiled by bun.

## First deploy

```sh
git clone <this fork> humanlayer && cd humanlayer
bun install
node_modules/.bin/wrangler login

cp .env.cloudflare.example .env.cloudflare
chmod 600 .env.cloudflare
# Edit .env.cloudflare: set CLOUDFLARE_ACCOUNT_ID, WORKERS_SUBDOMAIN and DATABASE_URL.

bun run cloudflare:deploy
```

What `bun run cloudflare:deploy` does, in order (all steps are idempotent):

1. Checks that wrangler is logged in to `CLOUDFLARE_ACCOUNT_ID`, that container images are
   registry references, and that `DATABASE_URL` is Postgres 18 with `wal_level = logical`.
2. Finds, by name, or creates the account resources: Hyperdrive config `humanlayer-db`, KV namespace
   `humanlayer-billing-cache`, R2 bucket `humanlayer-artifacts`, D1 database `humanlayer-auth`, and
   the queues `humanlayer-background-dlq` and `humanlayer-background`. It appends the ids it finds
   or creates (`HYPERDRIVE_ID`, `BILLING_KV_ID`, `AUTH_D1_DATABASE_ID`) to `.env.cloudflare`. It
   never touches a resource with another name.
3. Generates each missing secret (daemon token key pair, Electric secret, internal service
   secret, artifact URL signing secret, auth API key, auth signing key, auth webhook secret) and
   appends it to `.env.cloudflare`. A secret that is missing from the file but already set on a
   Worker is kept as is, never regenerated. An existing value is never replaced.
4. Runs the Postgres migrations (`packages/db`, drizzle-kit) and the D1 migrations
   (`apps/cf-auth/migrations`).
5. Renders each Worker's `wrangler.jsonc` to `wrangler.rendered.json` (see
   [How configuration reaches the Workers](#how-configuration-reaches-the-workers)).
6. Builds the CLI with this deployment's origins and auth service baked in, and uploads it to R2
   for cloud hosts and for you (skipped when the published build already matches).
7. Builds the web apps and docs, then deploys the Workers in an order that works on a first
   deploy (a service binding needs its target Worker to exist): streams, electric, hosts, auth,
   api, sync, jobs, cloud, app, docs. Each Worker's secrets are uploaded with its code.
8. Prints the URLs and the one remaining manual step.

The first deploy pulls two container images and builds three sites; expect it to take several
minutes. **(not verified)** The from-scratch path (every resource missing, every secret
generated) was implemented but not run: this guide was written against an existing deployment,
where re-running the script was verified to change no resource and no secret. Everything the
script does on a new account uses the same commands, run in the same order.

Useful flags:

```sh
bun run cloudflare:deploy:dry-run              # check, find resources, bundle and validate; change nothing
bun run cloudflare:deploy:list                 # targets, origins and resource ids
bun scripts/cloudflare/deploy.ts --only api,sync
bun scripts/cloudflare/deploy.ts --only sites  # alias for cloud,app,docs
bun scripts/cloudflare/deploy.ts --skip-migrations --skip-build --skip-cli
```

`--dry-run` creates nothing and writes nothing; resources that do not exist yet are reported as
"would be created" and rendered with placeholder ids so that `wrangler deploy --dry-run` can still
bundle and validate every Worker.

## Creating the first user and organization

Sign-up on the auth service is closed by default (only invited emails, or the emails and domains
in `AUTH_SIGNUP_ALLOWED_EMAILS` / `AUTH_SIGNUP_ALLOWED_DOMAINS`, can sign up). Create the first
user directly in D1:

```sh
cd apps/cf-auth
bun run bootstrap -- --email you@example.com --first-name You
```

The script generates a password, stores only its PBKDF2 hash in D1, and writes the email and
password to `apps/cf-auth/.bootstrap-credentials.json` (gitignored, mode 0600). Its output is the
new user id and that path. The deploy script prints this step until the auth service has a user.

Then create the organization. Either sign in to the cloud site (`CLOUD_ORIGIN`) and create it
there **(not verified in this fork's UI)**, or create it through the API with the end-to-end
script, which signs in as the bootstrap user:

```sh
CREATE_ORG="Your org" bun scripts/cloudflare/e2e/login-org-sync.ts
```

The organization's creator becomes its admin. Admins invite others from the app; the invitation
is not emailed (see [Known limitations](#known-limitations)): the accept link is listed for org
admins at `<AUTH_ORIGIN>/invitations`, and has to be sent to the invitee by hand.

## The env file

All deployment-specific values and secrets live in `.env.cloudflare` at the repo root. It is
gitignored; keep it mode 0600 and back it up somewhere safe. The tracked
[`.env.cloudflare.example`](.env.cloudflare.example) lists every key with a placeholder and a
comment. Format: `KEY=value` or `KEY='value'` (single quotes are literal, double quotes expand
`\n`).

### Required

| Key | Meaning |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account to deploy to |
| `WORKERS_SUBDOMAIN` | Your `workers.dev` subdomain; origins default to `https://humanlayer-<name>.<WORKERS_SUBDOMAIN>.workers.dev` |
| `DATABASE_URL` | Direct Postgres 18 URL with logical replication. Used by Electric, Hyperdrive and the migrations |

### Written by the deploy script

| Key | Meaning |
|---|---|
| `HYPERDRIVE_ID` | Hyperdrive config `humanlayer-db` |
| `BILLING_KV_ID` | KV namespace `humanlayer-billing-cache` |
| `AUTH_D1_DATABASE_ID` | D1 database `humanlayer-auth` |

Set one of these yourself only to reuse an existing resource; the script fails if a set id does
not exist on the account instead of creating another resource.

### Generated secrets

Generated when missing; never replaced by the script.

| Key | Used by |
|---|---|
| `RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY`, `RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY` | RS256 key pair (base64 PEM) for daemon tokens: api (both), sync (public) |
| `ELECTRIC_SECRET` | electric, sync |
| `INTERNAL_SERVICE_SECRET` | api, jobs and electric, to call hosts / guard workers.dev |
| `ARTIFACT_URL_SIGNING_SECRET` | api (signed artifact URLs) |
| `HUMANLAYER_AUTH_API_KEY` | auth (`API_KEY`), api (`WORKOS_API_KEY`) |
| `HUMANLAYER_AUTH_SIGNING_KEY_JWK` | auth (`SIGNING_KEY_JWK`, RS256 private JWK with `kid`) |
| `HUMANLAYER_AUTH_WEBHOOK_SECRET` | auth (`WEBHOOK_SECRET`), api (`WORKOS_WEBHOOK_SECRET`) |
| `HUMANLAYER_AUTH_SIGNING_KEY_JWK_PREVIOUS` | Optional, set by hand during a signing key rotation |

### Optional overrides and settings

| Key | Default | Meaning |
|---|---|---|
| `API_ORIGIN`, `SYNC_ORIGIN`, `APP_ORIGIN`, `CLOUD_ORIGIN`, `DOCS_ORIGIN`, `AUTH_ORIGIN`, `HOSTS_ORIGIN` | derived from `WORKERS_SUBDOMAIN` | Public origin of each Worker; set one when you move it to a custom domain |
| `WORKOS_API_HOSTNAME` | host of `AUTH_ORIGIN` | WorkOS-compatible API host used by the API, the sync proxy, the web apps and the CLI |
| `WORKOS_CLIENT_ID` | `client_humanlayer_cloudflare` | Public client id |
| `WORKOS_API_KEY` | `HUMANLAYER_AUTH_API_KEY` | Management API key the API uses |
| `WORKOS_WEBHOOK_SECRET` | `HUMANLAYER_AUTH_WEBHOOK_SECRET` | Verifies `/webhooks/workos` |
| `WORKOS_REDIRECT_URI` | `APP_ORIGIN` | Redirect URI the API and proxy are configured with |
| `WORKOS_API_HTTPS`, `WORKOS_API_PORT` | unset | Only for a plain-http local auth service |
| `AUTH_SIGNUP_ALLOWED_EMAILS`, `AUTH_SIGNUP_ALLOWED_DOMAINS` | empty | Self sign-up without an invitation |
| `AUTH_EXTRA_REDIRECT_URIS` | empty | Extra entries for the auth redirect allowlist |
| `AUTH_WEBHOOK_URL` | empty | Where the auth service posts membership webhooks, e.g. `<API_ORIGIN>/webhooks/workos` |
| `PLACEMENT_REGION` | `aws:us-east-1` | Region the API Worker is placed in; pick the one closest to the database |
| `IS_BILLING_ENFORCEMENT_ENABLED` | `false` | See [Enabling Stripe billing](#enabling-stripe-billing) |
| `CLI_TARGETS` | `linux-x64,linux-arm64,darwin-arm64,darwin-x64` | CLI platforms the deploy publishes (`all` adds `win32-x64`) |
| `DAYTONA_API_URL` | `https://app.daytona.io/api` | Daytona API base |

### Optional integrations

Uploaded to the Worker that uses them when set; skipped silently when absent. Unset integrations
fail only when a route that needs them is called.

| Worker | Keys |
|---|---|
| hosts | `DAYTONA_API_KEY`, `E2B_API_KEY`, `E2B_TEMPLATE` |
| api | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ENTERPRISE` |
| api | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM_EMAIL`, `RESEND_PRODUCT_USERS_SEGMENT_ID` |
| api | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` |
| api | `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_OAUTH_REDIRECT_URL` |
| api | `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`, `JIRA_OAUTH_REDIRECT_URL`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_OAUTH_REDIRECT_URL` |
| api | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `EXA_API_KEY`, `CONTEXT7_API_KEY` |
| api, sync | `SENTRY_DSN` (accepted; Sentry is a no-op on Workers) |
| api | `POSTHOG_API_KEY`, `POSTHOG_HOST` |
| web apps (build) | `VITE_PUBLIC_POSTHOG_KEY`, `VITE_PUBLIC_POSTHOG_HOST`, `VITE_PUBLIC_SENTRY_DSN` |

None of the optional integrations except Daytona were exercised on this deployment.

Removing a key from the env file does not remove the secret from the Worker (deploys keep
existing secrets). Delete it explicitly:
`cd apps/riptide-api && bun ../../scripts/cloudflare/wrangler.ts secret delete STRIPE_SECRET_KEY`.

## How configuration reaches the Workers

No tracked file contains a deployment-specific value. Each Worker's `wrangler.jsonc` is a
template: values such as `"id": "${HYPERDRIVE_ID}"` or `"PUBLIC_URL": "${AUTH_ORIGIN}"` are
placeholders, and `account_id` is absent. `scripts/cloudflare/config.ts` resolves them from
`.env.cloudflare` (applying the defaults above) and writes the effective config to
`<package>/wrangler.rendered.json`, which is gitignored. It refuses to write a config with an
unresolved placeholder.

Every wrangler command that talks to Cloudflare uses the rendered file:

- the deploy script;
- the package scripts (`bun run dev`, `bun run deploy`, `bun run migrate:remote`, and
  `worker:dev` / `worker:deploy` in the API and the proxy), which go through
  `scripts/cloudflare/wrangler.ts`. Run any other wrangler command for a package the same way:

```sh
cd apps/cf-jobs
bun ../../scripts/cloudflare/wrangler.ts versions list
```

Without `.env.cloudflare`, these commands stop with a message that says to create it. Typecheck,
lint and the unit tests do not need the env file.

A package-level `bun run deploy` deploys code and config but uploads no secrets; it works for a
Worker that already has its secrets. Use the deploy script for anything else.

## Cloud hosts

A cloud host is a sandbox that runs this fork's `humanlayer daemon launch`, so a user can run
agent sessions without their own machine. Users create one in the web app (Settings > Hosts >
New cloud host, or the host picker in the launcher). The API mints a daemon token for the host and
calls `humanlayer-hosts`, which starts the sandbox, installs the CLI from R2 and Claude Code, and
starts the daemon. Agent credentials the user enters (Anthropic API key or Claude Code OAuth
token, GitHub token) are passed through to the host and not stored by HumanLayer; the Cloudflare
provider keeps them in the host's Durable Object storage until the host is destroyed, so it can
re-bootstrap after a restart. Details: [apps/cf-hosts/README.md](apps/cf-hosts/README.md).

| | Cloudflare Containers | Daytona | E2B |
|---|---|---|---|
| Credentials | none (uses this account) | `DAYTONA_API_KEY` (optional `DAYTONA_API_URL`) | `E2B_API_KEY` (optional `E2B_TEMPLATE`, default `base`) |
| Size | fixed `standard-2` (1 vCPU, 6 GiB, 12 GB disk) | small 1 vCPU/2 GB, medium 2/4 GB (default), large 4/8 GB; 10 GB disk | set by the template |
| TTL | default 24 h, up to 30 days; a watchdog destroys it at expiry | same; enforced by Daytona | default 24 h, at most 24 h (1 h on E2B's Hobby plan) |
| Idle behaviour | kept alive until expiry | never auto-stops | killed by E2B at the timeout |
| Restart after a platform stop | re-bootstraps from stored inputs | not handled (host shows as stopped) | not handled |
| Status | verified: create, bootstrap, ready via daemon heartbeat, logs, destroy, token revocation, reconcile; also driven once from the web app in a browser (create, ready, host selectable in the launcher, logs, delete) | verified: same, except the reconcile check (run on Cloudflare only) | implemented, **never run against the real service** |

Costs that run continuously:

- Each Cloudflare host is a `standard-2` container that runs (and is billed) from creation until
  it is destroyed or expires; it does not sleep. At most 20 run at once (`max_instances`).
- Daytona and E2B hosts are billed by those providers while they run.
- Electric runs as one `basic` container while it has clients, and for 30 minutes after the last
  request. While awake it holds a replication connection to Postgres.
- `humanlayer-jobs` runs every minute and queries Postgres each time. A database that scales to
  zero when idle (Neon's default) will therefore not suspend. **(not measured)**
- Workers Paid plan base fee, plus usage of Workers, Durable Objects, R2, D1, KV, Queues and
  Hyperdrive.

The reconcile pass in `humanlayer-jobs` compares the API's host rows with the provider every
minute: a host that disappeared (expired, deleted outside the product) is marked destroyed and
its daemon token revoked.

## The CLI

The deploy publishes `humanlayer` CLI binaries built with this deployment's origins and auth
service baked in. They are served by `humanlayer-hosts` from R2:

```
<HOSTS_ORIGIN>/cli/latest/humanlayer-linux-x64     # what cloud hosts install
<HOSTS_ORIGIN>/cli/latest/humanlayer-linux-arm64
<HOSTS_ORIGIN>/cli/latest/humanlayer-darwin-arm64
<HOSTS_ORIGIN>/cli/latest/humanlayer-darwin-x64
<HOSTS_ORIGIN>/cli/latest.json                      # manifest: version, sha256 of each file
<HOSTS_ORIGIN>/cli/<version>/humanlayer-<platform>  # immutable
```

Install on your machine (macOS on Apple silicon shown):

```sh
HOSTS_ORIGIN=https://humanlayer-hosts.<WORKERS_SUBDOMAIN>.workers.dev
curl -fL -o humanlayer "$HOSTS_ORIGIN/cli/latest/humanlayer-darwin-arm64"
curl -fsS "$HOSTS_ORIGIN/cli/latest.json"   # compare files["humanlayer-darwin-arm64"].sha256 with: shasum -a 256 humanlayer
chmod +x humanlayer && mv humanlayer /usr/local/bin/
humanlayer login        # device login against humanlayer-auth: prints a URL and a code
humanlayer daemon launch
```

macOS may refuse to run an unsigned binary downloaded with a browser; `curl` does not set the
quarantine attribute. The binaries are not code-signed.

To build without publishing (output in `apps/cf-hosts/dist/cli/`):

```sh
cd apps/cf-hosts
bun run build:cli -- --targets darwin-arm64      # or linux-x64, linux-arm64, darwin-x64, win32-x64
bun run publish:cli -- --all                     # build every platform and publish
```

The build bakes `WORKOS_API_ORIGIN` (the auth service origin) and the client id; at runtime
`HUMANLAYER_WORKOS_URL` and `HUMANLAYER_WORKOS_CLIENT_ID` override them. The build refuses to
publish a binary that contains any secret value from `.env.cloudflare`.

Verified: the published darwin-arm64 binary (downloaded from `/cli/latest/`, checksum matching the
manifest) and a local build of the same configuration both start `humanlayer login` against the
`humanlayer-auth` origin and print the verification URL and code. The published linux-x64 binary
is what the cloud host checks install and run. Completing a login from the CLI, `humanlayer
daemon launch` on a user's machine, and the linux-arm64, darwin-x64 and win32-x64 binaries were
not run while writing this guide.

## Day-two operations

Redeploy everything, or a subset:

```sh
bun run cloudflare:deploy
bun scripts/cloudflare/deploy.ts --only api            # one Worker
bun scripts/cloudflare/deploy.ts --only sites --skip-migrations
```

A re-run creates no resource and rotates no secret: it finds the resources by id or name, keeps
every secret, and redeploys the Worker code and config. Container applications (Electric, the
host sandbox) keep their ids and are not modified, but the running Electric container is stopped (see
[Known limitations](#known-limitations)); use `--only` to leave `electric` out when it has not
changed.

Logs:

```sh
cd apps/riptide-api && bun ../../scripts/cloudflare/wrangler.ts tail
cd apps/cf-jobs     && bun ../../scripts/cloudflare/wrangler.ts tail --format pretty
```

(`wrangler tail` only needs the Worker name; plain `node_modules/.bin/wrangler tail humanlayer-api`
with `CLOUDFLARE_ACCOUNT_ID` exported also works.) Workers Logs (observability) is enabled on
every Worker, so past logs are in the dashboard too.

End-to-end checks (read `.env.cloudflare` and the bootstrap credentials; they create and destroy
their own cloud host):

```sh
bun scripts/cloudflare/e2e/login-org-sync.ts                       # sign-in, org-scoped token, API, sync shapes
bun scripts/cloudflare/e2e/cloud-host.ts --provider cloudflare     # or daytona, e2b
bun scripts/cloudflare/e2e/cloud-host-reconcile.ts --provider cloudflare
```

Right after a deploy that included `electric`, the first sync shape request can fail while
Electric starts (see [Known limitations](#known-limitations)); run the checks again before
treating that as a regression.

If a cloud host check fails midway, list and delete leftover hosts through the provisioner:

```sh
set -a; . ./.env.cloudflare; set +a
curl -s -H "authorization: Bearer $INTERNAL_SERVICE_SECRET" "$HOSTS_ORIGIN/v1/hosts"
curl -s -X DELETE -H "authorization: Bearer $INTERNAL_SERVICE_SECRET" "$HOSTS_ORIGIN/v1/hosts/<provider>/<hostId>"
```

(`HOSTS_ORIGIN` is `https://humanlayer-hosts.<WORKERS_SUBDOMAIN>.workers.dev` unless overridden.)

Rotating keys. The deploy script never rotates; to rotate, change the value in `.env.cloudflare`
and redeploy the Workers that use it:

| Secret | How |
|---|---|
| `INTERNAL_SERVICE_SECRET` | New random value; redeploy `--only electric,hosts,api,jobs` (calls between Workers fail until all four have it) |
| `ELECTRIC_SECRET` | New random value; redeploy `--only electric,sync` |
| `ARTIFACT_URL_SIGNING_SECRET` | New random value; redeploy `--only api`. Artifact links signed before are rejected |
| `RIPTIDE_DAEMON_TOKEN_*` | New key pair (`scripts/generate-daemon-keys.sh` prints base64 values); redeploy `--only api,sync`. Every existing daemon token, including cloud hosts', stops working: re-login daemons, recreate cloud hosts |
| `HUMANLAYER_AUTH_SIGNING_KEY_JWK` | Move the current value to `HUMANLAYER_AUTH_SIGNING_KEY_JWK_PREVIOUS`, put a new JWK (new `kid`) in place, redeploy `--only auth`. Both keys are published in the JWKS, so existing access tokens stay valid; remove the previous key after the access token TTL (1 h) |
| `HUMANLAYER_AUTH_API_KEY` | New value; redeploy `--only auth,api` (the API's `WORKOS_API_KEY` defaults to it) |

None of these rotations were performed on this deployment **(not verified)**.

Other operations:

- Database migrations run on every deploy unless `--skip-migrations`. To run them alone:
  `cd packages/db && DATABASE_URL=... bun --bun drizzle-kit migrate`.
- D1 (auth) migrations: `cd apps/cf-auth && bun run migrate:remote`.
- Back up the D1 database: `cd apps/cf-auth && bun ../../scripts/cloudflare/wrangler.ts d1 export humanlayer-auth --remote --output auth.sql` **(not verified)**.

## Switching to real WorkOS

The API, the sync proxy, the web apps and the CLI talk to `humanlayer-auth` only because their
WorkOS host and client id point at it. To use a WorkOS tenant instead **(not verified)**:

1. In WorkOS, create the client, allow the redirect URIs (`APP_ORIGIN`, `CLOUD_ORIGIN`, and the
   API's OAuth callbacks), enable device authorization for the CLI, and add a JWT template that
   puts `internal_org_id` (from organization metadata) into access tokens, as upstream does.
2. In `.env.cloudflare` set `WORKOS_API_HOSTNAME=api.workos.com`, `WORKOS_CLIENT_ID`,
   `WORKOS_API_KEY`, `WORKOS_WEBHOOK_SECRET`, and point the WorkOS webhook at
   `<API_ORIGIN>/webhooks/workos`.
3. `bun run cloudflare:deploy`. This redeploys the API and proxy with the new values, rebuilds the
   web apps and republishes the CLI with the WorkOS origin and client id. `humanlayer-auth` stays
   deployed but unused.

Users, organizations and memberships are not migrated between the two: ids differ, and
`organizations.workos_organization_id` in Postgres points at whichever service created the
organization. Switch before you have users, or plan a migration.

## Enabling Stripe billing

Billing is off by default: without `STRIPE_SECRET_KEY` and with `IS_BILLING_ENFORCEMENT_ENABLED`
unset (`false`), the API uses a billing-disabled service and organizations are created without a
Stripe customer. To turn it on **(not verified on Workers)**:

1. Create the products and prices in Stripe, and a webhook endpoint at
   `<API_ORIGIN>/webhooks/stripe`.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`
   (and `STRIPE_PRICE_ENTERPRISE` if used) in `.env.cloudflare`. Price ids start with `price_`.
3. Set `IS_BILLING_ENFORCEMENT_ENABLED=true` to enforce plans; it is passed to the API and baked
   into the web apps (`VITE_PUBLIC_BILLING_ENFORCEMENT_ENABLED`).
4. `bun run cloudflare:deploy`.

Enforcement on without `STRIPE_SECRET_KEY` is a misconfiguration: the API fails the operations
that need billing instead of running unbilled. Organizations created while billing was off have
no Stripe customer.

## Known limitations

- **The first deploy on a new account was not run.** The deploy script's provisioning path
  (creating the Hyperdrive config, KV namespace, R2 bucket, D1 database and queues, and generating
  every secret) is implemented but was only exercised against an existing deployment, where it
  found everything and created nothing.
- **E2B** cloud hosts are implemented but have never been run against the real E2B service.
- **No real agent session has run on a cloud host.** Hosts were created, bootstrapped, reported
  ready through the daemon heartbeat, and destroyed, on Cloudflare and Daytona; no model
  credential was available, so no Claude Code session was started on one.
- **The auth service is a WorkOS-compatible subset.** Email and password only: no SSO or social
  login, no MFA, no email verification, no password reset, no magic links, no Admin Portal, no
  domain verification (domains stay `pending`). Passwords use PBKDF2-HMAC-SHA256 at 100,000
  iterations, the most the Workers runtime allows (OWASP recommends 600,000 for
  PBKDF2-HMAC-SHA256). A forgotten password has no self-service path: create a new user with the
  bootstrap script or update the hash in D1 by hand. Full list:
  [apps/cf-auth/README.md](apps/cf-auth/README.md#not-implemented).
- **Invitations are not emailed.** The auth service returns the accept link instead of sending
  mail; org admins see pending invitations and their links at `<AUTH_ORIGIN>/invitations` and must
  pass them on.
- **Sentry is a no-op on Workers.** The Sentry calls are shimmed; errors are only in Workers Logs.
  `SENTRY_DSN` is accepted but unused by the Workers.
- **Long background LLM jobs run on a Queue** (`humanlayer-background`) instead of in-process as
  on Node: post-response work that can outlive a request (LLM titles and next-step extraction,
  delayed GitHub merge-state refresh) is consumed by the API Worker in batches of up to 4, with
  three retries before the dead-letter queue `humanlayer-background-dlq`. The LLM jobs only do
  anything when the AI provider keys are set.
- **Electric runs as one container on ephemeral disk.** There is a single instance (it holds the
  replication slot and an advisory lock), sized `basic` (1/4 vCPU, 1 GiB). It sleeps 30 minutes
  after the last request; the next start pulls the image, boots, and rebuilds every shape from
  Postgres, so the first sync after an idle period takes tens of seconds and clients refetch their
  shapes. Deploying `humanlayer-electric` stops the running container: observed on every
  redeploy, the container instance and Electric's replication session ended within about a minute
  of the deploy (the container application itself is unchanged). Observed after two
  redeploys: the first shape requests failed (503 "Snapshot timed out while waiting for a table
  lock", once also a 500) and succeeded when retried; Electric's replication session was up about
  15 seconds after the first request. The cause of the 503 was not investigated. Large
  workspaces may need `standard-1` (`apps/cf-electric/wrangler.jsonc`).
- **Deploying `humanlayer-hosts` probably restarts running Cloudflare cloud hosts** **(not
  verified)**: each host's container belongs to a Durable Object, and the Electric container
  (same mechanism) stops on every deploy. The host watchdog restarts and re-bootstraps a stopped
  host from its stored inputs, so the daemon should come back after a short outage. Avoid
  `--only hosts` deploys while hosts are in use, or check them afterwards.
- **The desktop apps are not ported.** The Electron and Tauri apps and their auto-updater
  (`apps/riptide-electron`, `apps/riptide-native`, `apps/updater-server`) were neither changed nor
  tested against this backend. Use the web app and the CLI.
- **The cloud host reconcile job exists only in the Cloudflare cron Worker** (`humanlayer-jobs`).
  A Node/AWS deployment of this code has no equivalent; there, expired hosts are not reconciled.
- **Cloud host size is fixed per deploy on Cloudflare** (`standard-2`), and per template on E2B;
  only Daytona honours the size picker.
- **Placement is a single region.** The API runs in `PLACEMENT_REGION`, next to the database;
  users far from it see the latency of that region.
- **Custom domains are not automated and were not tested.** The deploy script serves everything
  on `workers.dev`. To use a custom domain, attach it to the Worker yourself (dashboard, or a
  `routes` / `custom_domain` entry in that Worker's `wrangler.jsonc`), set the matching `*_ORIGIN`
  key, and run the whole deploy: origins are baked into the web apps, the auth redirect allowlist
  and the CLI, so users must also download the CLI again.
- **Local Worker development needs your own values.** `bun run dev` in a package renders the
  config from `.env.cloudflare` (so local `wrangler dev` uses the deployment's ids and origins),
  and Hyperdrive bindings need `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` locally.
  Because the Workers declare `secrets.required`, `wrangler dev` loads only those names (and vars)
  from `.dev.vars`.
