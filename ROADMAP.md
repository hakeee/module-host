# module-host roadmap

## v0.1: core (done)

Contracts (operations, events, pages, slots, entities); server host
(composition with pulled-in requirements, contract version checks,
table-ownership and foreign-key checks, per-module migrations, RPC over
HTTP, in-process typed clients, events, per-module vault scopes); web host
(typed hooks over TanStack Query, router, nav, slots with error
boundaries, entity links). First consumer: Ebba's people module.

## Next

- **Background jobs per module.** Each module declares job types and
  handlers; the worker becomes the host's job runner. Needs vault-service's
  scoped worker access (a secret per scope), so a module's worker can only
  decrypt that module's data.
- **Browser version check** against `GET /m/_manifest`: warn when the web
  bundle was built against different contract versions than the server
  runs (a stale tab after a deploy).
- **Batching for `labels` lookups**, so a timeline of 50 `<EntityLink>`s
  makes one request, not 50.
- **Lint rule** for "don't import another module's internals", beyond
  what package `exports` already block.
- **Publish** under `@hakeee/*`. This drops the linked-repo caveats in
  DESIGN.md.
