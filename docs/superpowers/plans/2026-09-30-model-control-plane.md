# Model Control Plane Implementation Plan

> **For agentic workers:** Implement tasks in order, with a test and review gate after each task. Inline execution is sufficient; this plan does not require delegation.

**Goal:** An operator can enter an OpenAI-compatible endpoint and credential in Admin Web, register a real model, assign primary/fallback models to a capability, and observe the next `world-agent` request use that configuration without restarting.

**Architecture:** Platform owns one versioned configuration and a private admin HTTP listener. A managed startup composes the existing Gateway server and Platform server in one process: Gateway serves configured physical model IDs, while Platform's existing capability router selects those IDs. A successful configuration write atomically replaces both live snapshots. The old independent Gateway and Platform entry points remain available for existing consumers, but cannot be edited by this admin workflow.

**Tech Stack:** Existing Node/TypeScript `platform` and `world-gateway`, Vue 3/Element Plus `admin-web`, Vitest, built-in `node:crypto` and filesystem APIs. No database, user system, or new provider-specific SDK.

**Spec:** `docs/ADMIN-API-GAP.md` G6, constrained by the user's 2026-09-30 request: real model onboarding now, user management later.

## Global Constraints

- Do not modify `world-engine/src`; use Gateway's public composition APIs and Platform's HTTP boundary.
- First release supports OpenAI-compatible chat endpoints only. Native Anthropic protocol, embeddings, pipeline editor, metering, quotas and user accounts are out of scope.
- No mock login token, public API key, or upstream model credential may authorize admin writes. Admin access requires an independently configured server-side token, loopback-only listener, and access control on the UI's reverse proxy.
- Upstream credentials never enter a Vite `VITE_*` variable, frontend bundle, readable config file, GET response, URL or log. Local keyless servers use an explicit `auth: "none"` option.
- Runtime configuration and operational limits (port, paths, timeout, permitted upstream hosts, secret-encryption key) come from server environment/configuration, not fixed deployment values in source.
- Preserve `/v1/models` public behavior (only `world-agent`) and the existing, independently used Gateway role router; the managed process routes physical model IDs separately.
- All managed-route references must point to enabled models with usable credentials. Missing or corrupt config must never silently fall back to imaginary demo models.

## Current Defects And Decision

| Defect | Evidence | Required outcome |
| --- | --- | --- |
| Provider, model and router edits only change fake-server memory | `admin-web/mock/admin/gateway.ts`; `src/api/{provider,model,router}.ts` | Real reads/writes and honest errors |
| Platform reads `platform/data/router.json` once; Gateway gets its providers at startup | `platform/src/router/modelrouter.ts`; `world-engine/gateway/src/server.ts` | One committed snapshot reaches both servers' call paths in the managed process |
| Platform's route values are Gateway channel names; the mock UI displays physical model names | `platform/src/types.ts`; `admin-web/mock/admin/gateway.ts` | Managed mode explicitly routes capability to configured physical model ID |
| A "provider check" is fabricated and the real probe requires typing an unrelated model ID | `admin-web/mock/admin/gateway.ts`; `src/views/gateway/providers/index.vue` | Test a stored model against its configured endpoint; show actual outcome |
| Fake login and fake API keys are not access control | `admin-web/mock/login.ts`; `platform/src/http/protocol.ts` | Private admin listener plus protected browser ingress, without implementing users |
| Vite proxy is dev-only and Docker's Nginx has no API routing | `admin-web/vite.config.ts`; `admin-web/Dockerfile` | Same-origin production proxy, or explicitly local-only delivery |
| UI budget/priority and provider status imply enforcement that does not exist | `admin-web/src/views/gateway/router/index.vue`; `admin-web/mock/admin/gateway.ts` | Remove these controls from the real workflow until enforcement exists |

**Chosen topology:** one managed Platform/Gateway process is the smallest configuration owner. Separate services with two writable config files would need coordination and rollback across processes. This choice can be revisited when services must scale independently; the config schema and private admin API remain the migration boundary.

## Runtime Contract

The versioned document stored outside the web root is:

```ts
interface ModelConfig {
  version: 1;
  revision: number;
  providers: Array<{
    id: string;
    name: string;
    endpoint: string; // OpenAI-compatible base URL, not a full chat URL
    auth: { kind: "secret"; secretId?: string } | { kind: "none" };
    enabled: boolean;
  }>;
  models: Array<{
    id: string; // stable internal ID, referenced by routes
    providerId: string;
    wireModel: string; // exact model string sent upstream
    tags: string[];
    enabled: boolean;
  }>;
  routes: Record<
    "roleplay" | "narrative" | "reasoning" | "fast" | "cheap" | "memory",
    { primary: string | null; fallback: string | null }
  >;
}
```

`GET /v1/admin/model-config` returns this document with `auth` reduced to `{kind, hasCredential}`; it never returns `secretId`. `PUT /v1/admin/model-config` accepts the same redacted document plus `If-Match: <revision>`: the server preserves the secret reference by provider ID, ignores any submitted `secretId`, and requires a separate credential write for a new provider. It returns the next revision only after durable write and live swap. It rejects an unknown provider reference, duplicate model ID, nonexistent/disabled primary or fallback, unusable secret on an enabled provider, unsafe URL, or revision mismatch. Null primary is allowed and honestly yields 503 for that capability. A provider starts disabled, so it can be created before entering a secret.

`PUT /v1/admin/providers/:id/credential` receives `{value: string}`, stores an encrypted replacement under a new secret ID, advances the config revision with the provider's new reference, and returns only the new revision and `hasCredential: true`. `POST /v1/admin/models/:id/test` allows a disabled model on a configured provider for pre-activation testing; `POST /v1/admin/routes/:capability/test` uses only the active route. Each runs one bounded, potentially billable chat request. Responses return model ID, elapsed time and a short sanitized output/error code; no raw upstream headers/body or secrets. Keep an encrypted previous secret version for rollback.

All these endpoints are served on a **separate loopback-only admin listener**. Require a constant-time-checked `PLATFORM_ADMIN_TOKEN` supplied by a server-side Vite/Nginx proxy (never by browser JavaScript). Also reject cross-origin writes; protect the admin UI itself at ingress. Public `/v1/*` continues to use its existing API-key authentication on the separate Platform listener. Treat remote endpoint URLs as privileged input: validate HTTP(S), reject credentials/fragment/redirects and disallowed targets, and apply a configurable host allowlist that can explicitly permit local inference servers. The allowlist must be checked on outbound requests, including DNS resolution policy, rather than relying only on URL syntax.

## Task 1: Configuration And Secrets

**Files:** create `platform/src/admin/model-config.ts`, `platform/src/admin/secrets.ts`, `platform/tests/model-config.test.ts`; modify `platform/src/config.ts`, `platform/package.json` and its lockfile.

**Interfaces:** `ModelConfigStore.load(): ModelConfig`, `validate(candidate): ValidationResult`, `commit(candidate, expectedRevision): ModelConfig`; `SecretStore.put(value): secretId`, `resolve(secretId): string | null`. Allow injecting a temporary directory, clock and outbound target validator into tests. Add a local `file:../world-engine/gateway` package dependency; build Gateway before Platform in the managed script.

- [ ] Write a failing test for corrupt-file refusal, revision conflict, duplicate/dangling references, disabled models, missing secrets, keyless local provider, and sanitized GET projection.
- [ ] Run only that test and confirm the intended failure; implement schema validation and stable IDs. Gateway's existing tags and Platform's `Capability` union are the allowed vocabularies.
- [ ] Add AES-256-GCM encryption with a server-provided master key, versioned secret records, restrictive filesystem permissions where supported, and no plaintext diagnostic output. Missing master key fails managed startup.
- [ ] Implement durable config replacement with a temporary file in the same directory, flush/rename, and previous revision backup. Return a failure without changing the active snapshot if validation or write fails.
- [ ] Re-run the focused tests, typecheck and inspect the on-disk JSON to confirm it contains no upstream credential.

## Task 2: Live Gateway And Platform Routing

**Files:** modify `world-engine/gateway/src/{provider,server,remote}.ts`, `platform/src/router/modelrouter.ts`, `platform/src/worldagent/pipeline.ts`; create `platform/src/admin/managed-runtime.ts`, `platform/scripts/run-managed.mjs`, `platform/tests/managed-runtime.test.ts`; extend Gateway regression tests.

**Interfaces:** Gateway server gets `replaceProviders(providers)` that swaps the registry as one snapshot; an in-flight request keeps its previously resolved provider. `ModelRouter.replaceRoutes(routes)` replaces all six managed routes and clears cooldown for removed/changed model IDs. `ManagedRuntime.apply(config)` validates and prepares a Gateway provider based on existing `remoteChat`/`remoteChatStream`, commits the config, then swaps both live views. The managed runner starts loopback Gateway, Platform and admin listener with non-conflicting configurable ports.

- [ ] Write failing tests: add a model after startup, route to it without restart, send a second request through actual `world-agent`, replace a route, remove an unused model, and verify an in-flight request completes on its old snapshot.
- [ ] Implement atomic provider replacement, physical-ID resolution and bounded primary/fallback behavior using the existing Platform router. Do not change the legacy standalone Gateway role router or legacy `run-platform.mjs`.
- [ ] Support explicit `auth: "none"` without sending an empty Bearer header. Sanitize upstream error bodies; report credential rejection separately from transient failure rather than cooling down every misconfiguration.
- [ ] Run Gateway and Platform focused tests and typechecks; verify startup with no configured models returns `503 no_model_configured`, never mock success.

## Task 3: Private Admin API

**Files:** create `platform/src/admin/http.ts`, `platform/tests/admin-http.test.ts`; extend `platform/scripts/run-managed.mjs`, `platform/src/config.ts`.

**Interfaces:** implement the four endpoints in Runtime Contract; `/healthz` for the private listener must not reveal config or credentials. HTTP errors use `{error:{code,message}}`: 400 malformed, 401 missing/invalid admin token, 409 revision conflict, 422 invalid configuration, 502 upstream test failure, 503 runtime unavailable. Tests do not mutate config. Admin reads never contain secrets.

- [ ] Write failing protocol and real-socket tests for unauthorized read/write, forged browser Authorization, cross-origin write, stale revision, submitted `secretId` forgery, malformed URL, missing credential, successful apply and live inference.
- [ ] Implement strict request-size limits, token comparison, origin check, bounded test timeout and request-ID logging without sensitive request bodies.
- [ ] Verify test endpoints call an actual local scripted OpenAI-compatible HTTP provider; assert that the configured `wireModel` and routing-selected physical ID were used.
- [ ] Run all Platform tests, including the existing public-auth and engine-proxy regression suite.

## Task 4: Admin Web Workflow

**Files:** modify `admin-web/src/api/{provider,model,router}.ts`, `src/views/gateway/{providers,models,router}/index.vue`, `vite.config.ts`, `mock/admin/gateway.ts`; add focused UI/API tests under `admin-web/tests` and a test runner only if the current toolchain can reuse installed dependencies.

**Interfaces:** frontend calls only same-origin `/control-api/v1/admin/*`; Vite/Nginx rewrites this to the private listener and injects its token server-side. The other Gateway demo pages (Pipelines/Keys/Usage) remain clearly marked Mock and cannot affect managed configuration. The UI keeps a draft and revision, saves a complete config, and reloads after `409`.

- [ ] Write failing UI tests for create-disabled-provider -> upload credential -> add model -> test -> enable -> assign capability -> save, plus invalid input, offline upstream and stale revision.
- [ ] Remove only Provider/Model/Router fake routes and their Mock labels; avoid having both fake and real handlers for the same workflow. Replace fixed example model names with values from the real config.
- [ ] Show `wireModel`, internal ID, credential-present state, active revision and actual test result. Remove fake budget/priority and fabricated provider health values.
- [ ] Set local Vite host to loopback for this workflow; do not expose `PLATFORM_ADMIN_TOKEN` through `VITE_*`, generated assets or browser headers. Run typecheck/build and a browser flow against a scripted upstream.

## Task 5: Packaging, Migration And Rollback

**Files:** add an explicit Nginx config under `admin-web/`, modify `admin-web/Dockerfile`, `platform/README.md`, `docs/ADMIN-API-{GAP,MAPPING}.md`; extend `platform/tests/loop.test.ts` with a managed-mode E2E.

- [ ] Build Gateway, Platform and Admin Web using lockfiles; run the managed script on spare local ports and confirm the public and private listeners stay distinct. Document real-network access as unsupported until the ingress protection is configured.
- [ ] Migrate existing `router.json` only by explicit operator action: map old channel names to real physical model IDs, review the result, test it, then activate the new config. Do not silently overwrite the old file or treat mock rows as provider truth.
- [ ] Add a protected same-origin production route for the admin UI/control API, a separate public API route, TLS/ingress instructions, and a runtime check that refuses to start admin mode without its token and encryption key.
- [ ] Run an end-to-end test using two scripted providers: primary success, primary transient failure -> fallback, both fail -> explicit error, credential rejection, restart preserves configuration, and stale revision cannot overwrite the winner.
- [ ] Verify rollback by restoring the previous config revision and encrypted secret version, reloading the live snapshot, then testing `world-agent` again. Retain existing independent scripts as a temporary emergency path, not as a second writable source of truth.

## Completion Gate

The feature is complete only when a browser-created model yields a real upstream response through the public `world-agent` endpoint **without restart**, remains active after restart, fails closed for missing credentials, and can be rolled back to the last working revision. Record HTTP status/body (redacted), UI result and test counts for each case. Public clients must still see only `world-agent` in `/v1/models`; existing 73 Engine, 24 Gateway and 36 Platform baseline tests must not regress. The engine core must have zero source changes.

**Deferred explicitly:** users/tenants, exposing admin on the public API port, native provider protocols, embedding routing, usage/cost accounting, per-day budgets, pipeline toggles, public API-key management and distributed multi-process config propagation. These need their own specs; presenting a mock as implemented is not acceptable.
