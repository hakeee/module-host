# module-host roadmap

## v0.1: core (done)

Contracts (operations, events, pages, slots, entities); server host
(composition with pulled-in requirements, contract version checks,
table-ownership and foreign-key checks, per-module migrations, RPC over
HTTP, in-process typed clients, events, per-module vault scopes); web host
(typed hooks over TanStack Query, router, nav, slots with error
boundaries, entity links). First consumer: Ebba's people module.

## v0.2: live, components, jobs (done)

- **Live updates:** `live: true` events pushed over a WebSocket to the
  emitting user's tabs. Re-checks the vault before every push and checks
  Origin. `invalidates` refetches queries with no client code;
  `useLiveEvent` and `useLiveStatus`; reconnects with a full refetch.
- **Shared components:** `component<Props>()` in contracts,
  `useComponent`, each in an error boundary, `null` when not installed.
- **Background jobs:** per-module typed jobs, a durable queue with
  payloads encrypted by the module's scope, waiting on a locked vault,
  retries with backoff, crash recovery. Runners can host a subset of
  modules, and `prepareVault` supports remote vaults (vault-service
  `createRemoteVault`).

## v0.3: across processes (done)

- `serverOnly` operations.
- Remote providers over a secret-gated internal channel. They count for
  composition and version checks, carry the caller, map errors and locked
  vaults, and validate on both ends.
- Live relay: a worker's live events reach the API's sockets.
- Scheduled jobs per active user (`activeCallers`); job visibility
  (`/_jobs`, `useJobs`, pushed live).
- `useContractVersionCheck()` against `/_manifest`; batched `<EntityLink>`
  labels.
- `slot()` / `component()` without props default to no props, so
  `<mod.Component of={ref} />` type-checks (it used to demand `never`).
- `Caller`/`Client` types moved to the root entry, so contract files can
  export typed helpers without dragging server types into browser
  type-checks.

## v0.4 (done)

- `JobDeferredError`: wait out a dependency's outage without spending
  attempts.
- `ctx.jobs.pendingCount`.

## Next

- **Cross-process event subscriptions:** a module in the API subscribing
  to events emitted in the worker, beyond the browser relay.
- **Lint rule** for "don't import another module's internals", beyond
  what package `exports` already block.
- **Publish** under `@hakeee/*`. This drops the linked-repo caveats in
  DESIGN.md.
