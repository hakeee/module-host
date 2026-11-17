# module-host design

Build an app out of **modules**: features that are kept apart and talk to
each other only through typed contracts. Modules are composed at build
time and run in one process. The goal is structure and type safety, not
a sandbox: you trust what you build and deploy.

## A module

One package per feature, with up to four entry points:

```
@app/module-people/
  contract   ← public: zod schemas + types. The only thing others import for data/UI access.
  schema     ← its Drizzle tables. Others import these only for foreign keys (see "Database").
  server     ← defineServerModule(...): handlers, routes, event subscriptions, migrations
  web        ← webModule(...).define(...): pages, nav entries, slot contributions
```

**Packaging:** `contract`, `schema` and `server` are compiled (`dist/`) for
Node. `web` ships as TypeScript source and is compiled by the app's
bundler. That keeps UI dependencies (component libraries, icons) out of
server images entirely; the module's `tsc` build excludes its web entry.

Any of these can be missing:

| Kind | Has | Example |
|---|---|---|
| Full feature | contract, server, web | people: data and pages |
| Backend + hooks, no UI | contract, server | an import job, or a data source other modules display. Its contract *is* its frontend hooks: any web module can `useModule(contract)` with no web package needed. |
| UI only | web (requires someone else's contract) | an alternative dashboard over people, or widgets contributed to other modules' pages |
| Server-only plumbing | server, no contract | a module that only subscribes to events |

## Contracts

```ts
export const peopleContract = defineContract({
  id: "people",            // also the vault scope, route prefix and table prefix
  version: 1,              // bump on breaking changes; hosts refuse to boot on mismatch
  queries:  { get: { input: z.object({ id: z.number() }), output: personDto } },
  commands: { update: { input: ..., output: ... } },
  events:   { renamed: z.object({ id: z.number() }) },
  pages:    { detail: { path: "/people/:id", params: z.object({ id: z.coerce.number() }) } },
  slots:    { "detail.sections": slot<{ personId: number }>() },
  entities: { person: { page: "detail", labels: "labels" } },
});
```

- **Schemas are Standard Schema** (zod 4 implements it). module-host never
  imports zod, so different zod copies across linked repos don't clash.
- **JSON-safe only.** The same operation is called over HTTP from the
  browser and in-process on the server; both must see identical values.
  Use strings for dates.
- **Both directions are validated.** Input is checked at every boundary (a
  400 over HTTP). Output is checked too, and parsing strips fields the
  contract doesn't declare, so a handler can't leak extra data.
- **Entities** make many modules feel like one app. Any module can show
  and link `people.person #3` (`<EntityLink>`), and can add UI to its page
  through slots, knowing only the contract.

## Composition and versions

Apps list top-level modules; `requires` pulls in the rest:

```ts
requires: [peopleServer]     // a module: installed automatically along with this one
requires: [peopleContract]   // a contract: someone must implement it (checked on the server)
```

At boot, each host checks the following:
- ids are unique;
- each contract has one implementation per side;
- required contracts exist (server side only, see below);
- every required `version` equals the implementation's;
- `requires` has no cycles (events may flow both ways);
- tables and foreign keys follow the database rules below.

Any failure stops the boot.

**Versioning:** contracts carry an integer version, not semver. Inside one
workspace everything moves in lockstep, so ranges add nothing. The version
check catches the cross-repo case: a module built against `people` v1 next
to an implementation of v2. Package versions themselves are pnpm's job.

The web host doesn't require contract implementations, because a UI-only
module over a backend-only contract has nothing to find on the web side.
The server host enforces them. `GET /m/_manifest` lists what the server
runs, which is enough for a later browser-side check.

## Server

```ts
export default defineServerModule({
  contract: peopleContract,
  requires: [journalServer],
  schema, migrationsFolder,
  implement: (ctx) => ({ queries: { get: (call, { id }) => ... }, commands: { ... } }),
  setup(ctx) {
    ctx.on(journalContract, "entryCreated", (call, payload) => ...);
    ctx.routes((app) => app.post("/upload", ...));   // for things that don't fit an operation
  },
});
```

- **`ctx.use(contract)` is typed from `requires`.** Using a contract the
  module didn't declare is a compile error, and a runtime error as well.
- **Calls carry the caller.** Handlers receive `call` =
  `{ userId, sessionId, vault }`, where `vault` is *the module's own*
  vault scope (named after its id). A module can only decrypt its own
  data; other modules get plaintext only through its contract. In-process
  calls pass the caller along: `people.queries.get(call, { id })`.
- **`legacyEncryption: true`** additionally exposes `call.legacy` (the
  vault's pre-scope format), for modules whose existing rows predate
  scopes. New modules shouldn't need it.
- **Expected failures:** throw `OperationError(404, "not found")`. Over
  HTTP it becomes that status.
- **HTTP:** every operation is served at `POST /<prefix>/<module>/rpc/<op>`,
  behind the app's auth hook. A locked vault gets a 423.
- **Events** run in-process after `emit` and are awaited. Each subscriber
  gets its own call context. A failing subscriber is logged and doesn't
  fail the emitter.

### Database

One SQLite database, with ownership checked at boot:

1. Each table belongs to exactly one module (`schema`).
2. Tables are named `<id>_...`. Tables that predate the module go in
   `legacyTableNames`, because renaming them would mean migrating live data.
3. Foreign keys may point only at the module's own tables, at tables of
   modules it requires **as modules** (always installed alongside it), or
   at the host's `sharedTables` (vault-service's `user`). Requiring only a
   contract doesn't allow foreign keys, since its implementation could be
   swapped. Reference that data by id through the contract instead.

Each module owns its migrations, tracked in `__module_<id>_migrations`.
They run in dependency order after vault-service's and before the app's
own: `createServerHost(...).migrate()`, or `migrateModules(db, modules)`
without a host. **Adopting existing tables:** make the module's first
migration `IF NOT EXISTS`, then remove those tables from the app's old
migration history. That's how vault-service took over its tables.

## Web

```tsx
const mod = webModule({ contract: peopleContract, requires: [journalWeb] });

function PersonPage({ params }: PageProps<typeof peopleContract.pages.detail>) {
  const people = mod.useModule(peopleContract);        // typed from requires
  const person = people.queries.get.useQuery({ id: params.id });
  return <>
    <h1>{person.data?.name}</h1>
    <Slot slot={peopleContract.slots["detail.sections"]} props={{ personId: params.id }} />
  </>;
}

export default mod.define({
  pages: { detail: PersonPage },                       // one component per contract page, enforced
  nav: [{ label: "People", to: peopleContract.pages.list, activeOn: [peopleContract.pages.detail] }],
  contributions: [contribute(journalContract.slots["entry.footer"], MentionedPeople)],
});
```

- Modules are **declared first and defined after**, so components written
  in between can call `mod.useModule`, typed against the module's requires.
- **Data hooks** come from the contract over TanStack Query:
  `.useQuery`, `.fetch`, `.key`, `.invalidate`, `.useMutation`, `.call`.
  Query keys are `[contractId, op, input]`, so invalidating `[contractId]`
  covers a whole module.
- **Router:** the host owns a small router. Paths come from contracts and
  params are parsed by the page's schema. `<Link to={page} params={...}>`
  is type-checked across modules, and the more specific path wins.
  TanStack Router was avoided because its type inference wants one route
  tree built in one place, which fights composing separately built modules.
- **Slots** render every contribution in order, each inside an error
  boundary, so one broken module can't blank another module's page.
  `useSlot(slot)` gives the raw list for custom layouts.
- **Nav** comes from the modules (`useNav()`, `useNavBadge(item)`). The
  app shell decides how to draw it.

## Rules that aren't enforced by types (yet)

- Don't import another module's `server`/`web` internals. Package
  `exports` only expose the entry points, so in practice the module object
  is all you can reach.
- A module touches only its own tables through `ctx.db`. The boot check
  covers ownership and foreign keys, not every query.

## Running linked (unpublished) repos

Repos consumed via `link:` each install their own devDependencies. Two
consequences:

- **Pin peer devDependencies to the app's exact versions** (fastify, react,
  @types/react, react-query, drizzle-orm, better-sqlite3). Interface types
  like Fastify's only clash when versions differ.
- **Declare the app's database type** via `Register`. Drizzle's types are
  classes, which never match across copies, even at the same version:

  ```ts
  declare module "@hakeee/module-host/server" {
    interface Register { db: BetterSQLite3Database<any> }
  }
  ```

  The app's Vite config must also `dedupe` react, react-dom and
  @tanstack/react-query.

Publishing the packages, with real peer dependencies, makes the first
point go away.
