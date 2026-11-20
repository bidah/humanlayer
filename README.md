# human-flare

**human-flare is a fork of [HumanLayer](https://github.com/humanlayer/humanlayer) that runs on Cloudflare instead of AWS.**

HumanLayer runs coding agents (Claude Code, Codex, OpenCode, Pi) on your machines and lets your team steer them from one place: tasks, sessions, plans, and reviews, synced between a desktop app, a web app, and a daemon on each host. Upstream HumanLayer Cloud runs on AWS: ECS Fargate, Lambda, RDS, MemoryDB, S3 and CloudFront, deployed with Pulumi, with WorkOS for sign-in.

This fork replaces each of those with a Cloudflare product, so the whole backend deploys to one Cloudflare account with one command and no Docker:

| Upstream (AWS) | human-flare (Cloudflare) |
|---|---|
| API and sync proxy on ECS Fargate | Workers `human-flare-api` and `human-flare-sync` |
| Electric on Fargate | `human-flare-electric`, a Cloudflare Container |
| Rust durable streams server | `human-flare-streams`, on SQLite-backed Durable Objects |
| RDS Postgres | Any Postgres 18 with logical replication (for example Neon), through Hyperdrive |
| MemoryDB (Redis) | Workers KV |
| S3 artifacts | R2 |
| Lambda jobs + EventBridge | `human-flare-jobs`, on Cron Triggers, plus Queues for background work |
| WorkOS | `human-flare-auth`, a WorkOS-compatible auth service on D1 (real WorkOS is still a config switch) |
| S3 + CloudFront sites | `human-flare-app`, `human-flare-cloud`, `human-flare-docs` on Workers Static Assets |
| (none) | `human-flare-hosts`: daemon hosts in cloud sandboxes (Cloudflare Containers, Daytona, E2B) |

The Cloudflare code is added alongside the upstream code; it doesn't replace it. The Node/AWS entry points are unchanged, so the fork can keep merging from upstream. To deploy it, see [CLOUDFLARE.md](CLOUDFLARE.md):

```sh
bun install
cp .env.cloudflare.example .env.cloudflare   # set CLOUDFLARE_ACCOUNT_ID, WORKERS_SUBDOMAIN, DATABASE_URL
bun run cloudflare:deploy
```

CLOUDFLARE.md covers the architecture, configuration, operations and known limitations. The rest of this README is upstream's.

## HumanLayer

This repo holds all of HumanLayer. It's a [Turborepo](https://turborepo.com) monorepo that uses [Bun](https://bun.sh).

### What's here

- `apps/riptide-ui`: the app, as a web app and inside the desktop shells
- `apps/riptide-electron`, `apps/riptide-native`: the macOS desktop apps (Electron, Tauri)
- `apps/riptide-daemon`: the daemon that runs agent sessions on a host
- `apps/cli`: the `humanlayer` CLI, which also ships the daemon
- `apps/riptide-api`: the oRPC + Hono API
- `apps/riptide-electric-proxy`: the auth proxy in front of [Electric](https://electric-sql.com), which syncs Postgres to clients
- `apps/riptide-cloud`: the admin web app (organizations, invites, settings, install page)
- `apps/riptide-migrator`, `apps/updater-server`, `apps/stale-daemon-sweeper`, `apps/database-maintenance-function`: AWS Lambda jobs
- `apps/riptide-claude-code-plugin`, `apps/riptide-opencode-plugin`, `apps/riptide-pi-extension`: plugins that mirror Claude Code, OpenCode, and Pi sessions into HumanLayer
- `apps/riptide-humanlayer-claude-plugin`: the built-in HumanLayer skills
- `apps/riptide-rpi-claude-plugin`, `apps/linear-cli`: the Research-Plan-Implement skills and the Linear CLI
- `apps/docs`: the user docs
- `apps/devstack`: runs a full local stack per worktree
- `packages/`: shared libraries (`db`, `schemas`, `ui`, `sync`, `ai`, `billing`, ...)
- `contracts/`: the oRPC and Effect RPC contracts between the apps

### Get started

You need [Bun](https://bun.sh) and Docker. Building `apps/riptide-native` also needs Rust.

```
bun install
cp .env.example .env
bun --bun run typecheck
bun run test
```

`bun --bun run devstack help` explains how to run the whole stack locally. [CONTRIBUTING.md](CONTRIBUTING.md) lists every check a pull request must pass.

A build from source sends nothing to us: Sentry, PostHog, and the WorkOS client ID come from env, and stay off when unset. `.env.example` lists them.

### Self-hosting on AWS

HumanLayer Cloud runs this code on AWS. [`.claude/skills/self-host-humanlayer/`](.claude/skills/self-host-humanlayer/SKILL.md) holds a reference copy of our Pulumi stacks and GitHub Actions workflows, with every secret and HumanLayer-specific value replaced by a placeholder. It also covers the services, the order to deploy them in, and what you must change. Open it in Claude Code, or another agent that reads skills, and ask it to help you self-host HumanLayer.

It's a reference, not a supported install: expect to adapt it.

To run on Cloudflare instead, see the top of this README and [CLOUDFLARE.md](CLOUDFLARE.md).


⚠️ note - If you use the Docker Compose file as a starter for self hosting, please note that it uses default/simple passwords that should be updated before you deploy.


## License

[Apache License 2.0](LICENSE). A few vendored folders keep their MIT licenses; [NOTICE](NOTICE) lists them.
