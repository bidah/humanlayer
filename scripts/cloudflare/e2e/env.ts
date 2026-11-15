// Settings for the end-to-end checks: the repo's .env.cloudflare, with exported variables taking
// precedence (so `set -a; . ./.env.cloudflare; set +a` keeps working, and single values can be
// overridden). Origins are derived like the deploy script derives them (scripts/cloudflare/config.ts).
import { readEnvFile, resolveAuth, resolveOrigins } from '../config'

export const deploymentEnv: Record<string, string | undefined> = { ...readEnvFile(), ...process.env }
const origins = resolveOrigins(deploymentEnv)

export const API = origins.api
export const SYNC = origins.sync
export const APP = origins.app
export const HOSTS = origins.hosts
export const AUTH = origins.auth
export const CLIENT_ID = resolveAuth(deploymentEnv, origins).clientId
