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

## Next

- **Live events from worker processes:** a worker that emits an event
  should reach the API's sockets. Likely a small "publish" call to the API
  over the internal channel, or a notification table the API polls.
- **Scheduled jobs:** periodic work per unlocked session (e.g. Ebba's
  nightly tag maintenance), declared by modules instead of hand-rolled
  timers.
- **Job visibility:** a contract-level way for a module's UI to show its
  own job progress (queued/running/failed), like Ebba's current jobs list.
- **Browser version check** against `GET /m/_manifest`: warn when the web
  bundle was built against different contract versions than the server
  runs (a stale tab after a deploy).
- **Batching for `labels` lookups**, so a timeline of 50 `<EntityLink>`s
  makes one request, not 50.
- **Lint rule** for "don't import another module's internals", beyond
  what package `exports` already block.
- **Publish** under `@hakeee/*`. This drops the linked-repo caveats in
  DESIGN.md.
