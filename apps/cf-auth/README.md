# @humanlayer/cf-auth: a WorkOS-compatible auth service

This package is the Cloudflare Worker `human-flare-auth` (`https://human-flare-auth.<WORKERS_SUBDOMAIN>.workers.dev` unless `AUTH_ORIGIN` overrides it), backed by the D1 database `human-flare-auth`. It is deployed with the rest of the stack by `bun run cloudflare:deploy`; see [CLOUDFLARE.md](../../CLOUDFLARE.md).

It implements the part of the WorkOS HTTP API that this repo's SDK calls use:

- `@workos-inc/node` 10.11.0 in `riptide-api`
- `@workos-inc/node` 7.82.0 in `riptide-electric-proxy`
- `@workos-inc/authkit-js` 0.20.2, through `@workos-inc/authkit-react` 0.16.2, in `riptide-ui` and `riptide-cloud`
- the device-code login used by the CLI and the session SDK

It also serves its own email-and-password sign-in pages. The SDKs are not modified; they are pointed at this host by hostname. Switching back to a real WorkOS tenant only takes configuration changes; see [Switching between this service and WorkOS](#switching-between-this-service-and-workos).

## Endpoints

### Browser and public endpoints (no API key)

| Method | Path | Used by | Notes |
|---|---|---|---|
| GET | `/sso/jwks/:clientId` | API and proxy, through `userManagement.getJwksUrl` | Returns RS256 public keys (`kty`, `alg`, `use`, `kid`, `n`, `e`). Returns 404 for an unknown client id. |
| GET, POST | `/user_management/authorize` | authkit-js `signIn`, `getSignInUrl`, `switchToOrganization` fallback | The hosted sign-in, sign-up and organization-picker page. Requires PKCE with `S256`. The `redirect_uri` must be on the allowlist. Honors `organization_id`, `screen_hint`, `login_hint`, `invitation_token` and `state`. |
| POST | `/user_management/authenticate` | authkit-js, API `authenticateWithRefreshToken`, CLI and session SDK | Accepts a JSON or form body. Supports three `grant_type`s: `authorization_code` (PKCE), `refresh_token` (rotating; `organization_id` re-scopes the session) and `urn:ietf:params:oauth:grant-type:device_code`. Sends CORS headers for allowlisted origins. |
| POST | `/user_management/authorize/device` | CLI and session SDK | Returns `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `interval` and `expires_in`. |
| GET, POST | `/device` | The browser part of device login | Sign in, check the code, pick an organization, then approve or deny. |
| GET | `/user_management/sessions/logout` | authkit-js `signOut` | Ends the session given by `session_id` and the hosted browser session. Redirects to `return_to` only if it is on the allowlist. |
| GET, POST | `/invitations/accept?invitation_token=` | `accept_invitation_url` | Lets the invitee sign up or sign in, then accepts the invitation. |
| GET, POST | `/invitations` | Organization admins | Lists pending invitations and their acceptance links for every organization where the signed-in user is an admin. |
| POST | `/session/switch` | Hosted pages | The "Use a different account" button. |

### Management API (`Authorization: Bearer <API_KEY>`)

| SDK call | HTTP request |
|---|---|
| `userManagement.getUser` | `GET /user_management/users/:id` |
| `userManagement.listUsers({ email, organizationId })` | `GET /user_management/users` |
| `userManagement.listOrganizationMemberships({ userId, organizationId, statuses })` | `GET /user_management/organization_memberships`. `statuses` defaults to `active`. |
| `userManagement.createOrganizationMembership` | `POST /user_management/organization_memberships` |
| `userManagement.updateOrganizationMembership` | `PUT /user_management/organization_memberships/:id` |
| `userManagement.deleteOrganizationMembership` | `DELETE /user_management/organization_memberships/:id` |
| `userManagement.deactivateOrganizationMembership` | `PUT /user_management/organization_memberships/:id/deactivate` |
| `userManagement.reactivateOrganizationMembership` | `PUT /user_management/organization_memberships/:id/reactivate` |
| `userManagement.sendInvitation` | `POST /user_management/invitations`. No email is sent; the response contains `accept_invitation_url`. |
| `userManagement.listInvitations({ email, organizationId })` | `GET /user_management/invitations` |
| `userManagement.getInvitation` | `GET /user_management/invitations/:id` |
| `userManagement.findInvitationByToken` | `GET /user_management/invitations/by_token/:token` |
| `userManagement.acceptInvitation` | `POST /user_management/invitations/:id/accept`. A user with the invitation's email must already exist. |
| `userManagement.revokeInvitation` | `POST /user_management/invitations/:id/revoke` |
| `userManagement.createUserApiKey` | `POST /user_management/users/:id/api_keys`. Returns the value once, prefixed `hlk_`. |
| `userManagement.listUserApiKeys` | `GET /user_management/users/:id/api_keys` |
| `apiKeys.createValidation` | `POST /api_keys/validations`. Returns `{ api_key: null }` when the key is unknown, expired or deleted, or the user's membership is no longer active. |
| `apiKeys.deleteApiKey` | `DELETE /api_keys/:id` |
| `organizations.createOrganization` | `POST /organizations` |
| `organizations.getOrganization` | `GET /organizations/:id` |
| `organizations.updateOrganization` | `PUT /organizations/:id`. `metadata` is merged, and setting a key to `null` or `""` removes it. |
| `organizationDomains.createOrganizationDomain` | `POST /organization_domains`. New domains stay `pending`, because nothing verifies DNS. |
| `organizationDomains.deleteOrganizationDomain` | `DELETE /organization_domains/:id` |
| `adminPortal.generateLink` | `POST /portal/generate_link`. Not supported on purpose: it returns 400 `not_supported`. |

Lists use the WorkOS response shape `{ object: "list", data, list_metadata: { before, after } }` with cursor pagination, so `autoPagination()` works. Errors use the shapes the SDK maps to its exception types:

| Status | Body | SDK exception |
|---|---|---|
| 401 | | `UnauthorizedException` |
| 404 | `{ code, message }` | `NotFoundException` |
| 422 | `{ code, message, errors }` | `UnprocessableEntityException` |
| 400 | `{ code, message }` | `GenericServerException` |
| 400 or 401 | `{ error, error_description }` (token endpoint) | `OauthException` |

The API branches on some error messages, and this service keeps them: "User already a member of organization." and "Email already invited to organization."

### Access token claims

Access tokens are RS256 JWTs with the claim layout of `packages/schemas/src/effect/workos-access-token.ts`:

| Claim | Value |
|---|---|
| `iss` | `<PUBLIC_URL>/user_management/<CLIENT_ID>` |
| `sub` | `user_…` |
| `sid` | `session_…` |
| `jti` | Unique token id |
| `iat`, `exp` | Issue and expiry times |

When the session is scoped to an organization, the token also has `org_id`, `role`, `roles`, `permissions`, `entitlements` and `feature_flags`. It also has `internal_org_id`, taken from `organization.metadata.internal_org_id`. Upstream WorkOS adds that claim with a JWT template.

There is no `aud` claim. Neither consumer pins the audience.

### Webhooks

When both `WEBHOOK_URL` and the `WEBHOOK_SECRET` secret are set, membership changes send signed `organization_membership.created`, `.updated` and `.deleted` events. The header is `WorkOS-Signature: t=<ms>, v1=<hex HMAC-SHA256>`, which the API verifies with `webhooks.constructEvent`.

The API already re-syncs seats after its own membership writes. The webhook only adds the access-request backfill on `.created` and covers invitations accepted on the hosted page.

## Security model

- **Passwords.** Hashed with PBKDF2-HMAC-SHA256 through WebCrypto, using 100,000 iterations and a 16-byte salt. 100,000 is the most iterations the Workers runtime allows. The iteration count is stored in each hash.
- **Rate limiting.** Failed password attempts are counted in D1, in 15-minute windows: at most 10 per email and 50 per client IP. When the limit is reached, the response is 429.
- **No account enumeration on sign-in.** An unknown email and a wrong password get the same message, and both cost a full password check.
- **Sign-up is closed.** It is open only to emails with a pending invitation, or to emails or domains on `SIGNUP_ALLOWED_EMAILS` or `SIGNUP_ALLOWED_DOMAINS`. Eligibility is checked before account existence, so a caller who is not eligible learns nothing about which accounts exist.
- **CSRF.** Hosted forms use a double-submit token (`__Host-hl_csrf`, `SameSite=Strict`). A form post is rejected if its `Origin` is not this service or if `Sec-Fetch-Site` shows a cross-site request.
- **Hosted browser session.** The session cookie is `__Host-hl_session`, with `HttpOnly`, `Secure` and `SameSite=Lax`. The database stores only its SHA-256 hash.
- **Redirects.** `redirect_uri` must exactly match an allowlist entry, or match the origin of an `<origin>/*` entry. Hostname patterns are never used. If a client or redirect URI is invalid, the service shows an error page and does not redirect.
- **Authorization codes.** Codes are stored hashed and are valid for 5 minutes. Each code is single use, enforced with an atomic `UPDATE … RETURNING`. A code is bound to its client, redirect URI and PKCE challenge. If a code is replayed, the session issued from it is revoked.
- **Refresh tokens.** Refresh tokens are opaque and stored hashed. They rotate on every use. If a rotated token is presented again, the whole session is revoked.
- **Secrets.** The API key and client secret are compared in constant time. Secrets never appear in URLs or logs.

## Configuration

These are the `vars` in `wrangler.jsonc`. That file is a template: the `${NAME}` placeholders are filled from the repo's `.env.cloudflare` when the config is rendered (`scripts/cloudflare/config.ts`), so the values below name the env key that sets each one.

| Variable | Meaning |
|---|---|
| `CLIENT_ID` | The public client id, `client_humanlayer_cloudflare`. Every app's WorkOS client id must be this value. |
| `PUBLIC_URL` | The external origin (`AUTH_ORIGIN`). It is used in `iss` and in links. |
| `ALLOWED_REDIRECT_URIS` | Redirect allowlist, separated by spaces or commas. Each entry is an exact URI or `<origin>/*`. The browser CORS allowlist uses the origins of these entries. The template allows the app, cloud and API origins, `localhost:3000`, `localhost:5174` and `riptide://oauth/callback`; `AUTH_EXTRA_REDIRECT_URIS` adds more. |
| `SIGNUP_ALLOWED_EMAILS`, `SIGNUP_ALLOWED_DOMAINS` | Self sign-up without an invitation (`AUTH_SIGNUP_ALLOWED_EMAILS`, `AUTH_SIGNUP_ALLOWED_DOMAINS`). Empty by default, so sign-up is closed. |
| `ROLE_SLUGS` | Allowed membership roles. The default is `admin,member,manager`. |
| `ACCESS_TOKEN_TTL_SECONDS` | Default 3600. The CLI assumes one-hour tokens. |
| `REFRESH_TOKEN_TTL_SECONDS` | Default 2592000 (30 days). This is also the maximum session length. |
| `INVITATION_LANDING_URL` | The link shown after an invitation is accepted on the hosted page (`<CLOUD_ORIGIN>/`). |
| `WEBHOOK_URL` | Optional (`AUTH_WEBHOOK_URL`). For example `<API_ORIGIN>/webhooks/workos`. |

The deploy script generates these into the repo's gitignored `.env.cloudflare` when they are missing and uploads them with each deploy. `bun run secrets:generate` and `bun run secrets:put` do the same for this Worker alone:

| Worker secret | `.env.cloudflare` key | Purpose |
|---|---|---|
| `API_KEY` | `HUMANLAYER_AUTH_API_KEY` | Bearer key for the management API. Use it as `WORKOS_API_KEY` in the API and the proxy. |
| `SIGNING_KEY_JWK` | `HUMANLAYER_AUTH_SIGNING_KEY_JWK` | RS256 private key, as a JWK that includes `kid`. |
| `SIGNING_KEY_JWK_PREVIOUS` | `HUMANLAYER_AUTH_SIGNING_KEY_JWK_PREVIOUS` (set manually) | Optional. Keeps the previous key in the JWKS while you rotate keys. |
| `WEBHOOK_SECRET` | `HUMANLAYER_AUTH_WEBHOOK_SECRET` | Use it as `WORKOS_WEBHOOK_SECRET` in the API. |

## Operating the service

```sh
cd apps/cf-auth
bun run test                       # starts wrangler dev (workerd + local D1); no Docker or env file needed
bun run migrate:remote             # apply migrations/ to the D1 database human-flare-auth
bun run secrets:generate && bun run secrets:put
bun run deploy                     # renders wrangler.jsonc from .env.cloudflare, then wrangler deploy
bun run bootstrap -- --email you@example.com --first-name You
```

Every command except `test` reads the repo's `.env.cloudflare` (account id, D1 database id, origins).

`bun run bootstrap` creates the first user. It generates a password and stores only its hash in D1. It writes the email and password to `apps/cf-auth/.bootstrap-credentials.json`, which is gitignored and has mode 0600. Its output shows only the new user id and that file path.

To create organizations, use the app, which calls the API's `organizations.create` procedure. That procedure stores `internal_org_id` in the organization's metadata and makes the creator an admin.

## Switching between this service and WorkOS

Every seam defaults to real WorkOS when it is unset:

| Consumer | Setting for this service | Setting for real WorkOS |
|---|---|---|
| `riptide-ui` and `riptide-cloud` (build env) | `VITE_PUBLIC_WORKOS_API_HOSTNAME=human-flare-auth.<WORKERS_SUBDOMAIN>.workers.dev` and `VITE_PUBLIC_WORKOS_CLIENT_ID=client_humanlayer_cloudflare`. Optionally `VITE_PUBLIC_WORKOS_API_HTTPS=false` and `VITE_PUBLIC_WORKOS_API_PORT=8787` for a local `wrangler dev`. | Leave the hostname unset and use the WorkOS client id. |
| `riptide-api` and `riptide-electric-proxy` (runtime env) | `WORKOS_API_HOSTNAME=human-flare-auth.<WORKERS_SUBDOMAIN>.workers.dev`, `WORKOS_API_KEY=<HUMANLAYER_AUTH_API_KEY>`, `WORKOS_CLIENT_ID=client_humanlayer_cloudflare`. The API also needs `WORKOS_WEBHOOK_SECRET` if `WEBHOOK_URL` is set. | Leave `WORKOS_API_HOSTNAME` unset and use the real key and client id. |
| CLI | Build env `WORKOS_API_ORIGIN=https://human-flare-auth…` (Bun macro), or `HUMANLAYER_WORKOS_URL` at runtime, together with the `*_WORKOS_CLIENT_ID` macros. | Leave both unset to use `https://api.workos.com`. |
| Session SDK and plugins | Set `workos` in a channel of `HUMANLAYER_CHANNELS` at build time, or `HUMANLAYER_WORKOS_URL` at runtime, together with `clientId` or `HUMANLAYER_WORKOS_CLIENT_ID`. | Leave them unset. |

Users, organizations and memberships are not migrated between this service and WorkOS. Their ids are different, and `organizations.workos_organization_id` in Postgres points at whichever service created the organization.

## Not implemented

- Admin Portal links. The call returns an error.
- SSO, OAuth providers, magic auth, MFA, email verification, password reset and the `password` grant.
- The cookie-mode refresh that AuthKit uses when `devMode` is off: an `HttpOnly` cookie on the auth domain. Both browser apps hard-code `devMode={true}`, which keeps the refresh token in `localStorage`, and that mode is supported.
- Domain verification. Domains stay `pending`.
- The `sessions.revoke` endpoint and listing sessions.
