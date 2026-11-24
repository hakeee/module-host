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
| Backend + UI kit | contract, server, web with only `components` | offers pickers/chips others place, no pages of its own |
| UI only | web (requires someone else's contract) | an alternative dashboard over people, or widgets contributed to other modules' pages |
| Server-only plumbing | server, no contract | a module that only subscribes to events |

## Contracts

```ts
export const peopleContract = defineContract({
  id: "people",            // also the vault scope, route prefix and table prefix
  version: 1,              // bump on breaking changes; hosts refuse to boot on mismatch
  queries:  { get: { input: z.object({ id: z.number() }), output: personDto } },
  commands: { update: { input: ..., output: ... } },
  events:   {
    renamed: { payload: z.object({ id: z.number() }), live: true, invalidates: ["get"] },
    audited: z.object({ id: z.number() }),            // short form: server-side only
  },
  pages:    { detail: { path: "/people/:id", params: z.object({ id: z.coerce.number() }) } },
  slots:    { "detail.sections": slot<{ personId: number }>() },
  components: { PersonPicker: component<{ onPick(id: number): void }>() },
  entities: { person: { page: "detail", labels: "labels" } },
});
```

- **Schemas are Standard Schema** (zod 4 implements it). module-host never
  imports zod, so different zod copies across linked repos don't clash.
- **JSON-safe only.** The same operation is called over HTTP from the
  browser and in-process on the server; both must see identical values.
  Use strings for dates.
- **`serverOnly: true`** on an operation: other modules can call it
  (in-process or across processes), but it isn't served to browsers. Use
  it for things like AI generation.
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
    ctx.publicRoutes((app) => app.get("/:token", ...)); // no login: feeds, webhooks
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
- **Public routes** (`ctx.publicRoutes`) are reachable **without a
  login**, for things a browser session can't carry: calendar feeds,
  webhooks, booking pages. The app mounts `host.publicRoutes` under its own
  prefix (e.g. `/p`), *outside* its auth hook, and the module authenticates
  each request itself (a secret token, a signature). The host rate-limits
  them per IP (`publicRateLimit`, default 120 a minute; IPv6 per /64) and turns an
  `OperationError` into its status. To act as a user, call operations with
  `{ userId, sessionId }`: they go through IAM like any other call, so a
  feed shows only what its owner may see. Only `vault: false` operations
  work that way, since there is no unlocked session behind the request.
- **`vault: false`** on an operation lets it run for a logged-in caller
  whose vault is locked (e.g. the user's email, a count, a setting). Its
  handler gets only `{ userId, sessionId }`, with no vault scope, so the
  compiler stops it from decrypting anything. Whatever it returns is
  readable by anyone holding the login cookie, so it must be plain data.
  It needs the host option `requireCaller` (vault-service's
  `createRequireCaller`), and the host refuses to boot without it.
- **Events** run in-process after `emit` and are awaited, also while the
  emitter's vault is locked: the subscriber's `call.vault` then throws
  `ModuleVaultLockedError` when touched, so plain-data work still runs. Each subscriber
  gets its own call context. A failing subscriber is logged and doesn't
  fail the emitter.
- **Privacy (GDPR) hooks.** A module says how to export and how to erase
  what it holds about one data subject: `ctx.privacy.handle("user", {
  export, erase })`, or an app-defined subject such as `"client"`. A
  coordinating module runs everyone's with `ctx.privacy.run("export" |
  "erase", call, subject, id, { terms, id })`.
  - Exports run in dependency order, erasures dependents first (contract
    requirements count).
  - Hooks get the requesting caller, plus the module's own vault scope when
    the request runs unlocked, so encrypted data can be exported only by its
    owner. `terms` (e.g. a name) let hooks list free text that mentions the
    subject for a person to review; `id` lets a hook whose part arrives later
    tie it to the request.
  - `erase` returns a report: `removed`, `anonymized`, `kept` (with why) and
    `review` items.
  - With the host option `requirePrivacy`, every module with tables must
    register hooks or call `ctx.privacy.none(reason)`, or the host refuses to
    boot. Off by default. The built-in IAM module handles `"user"` (its roles;
    root is never erased).

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
- **`<EntityLink>` batches:** label lookups made in the same tick go out as
  one request per entity type, so a timeline of 50 person links is one
  call.
- **Locked vs unlocked:** by default an app renders modules only once the
  vault is unlocked. To render them while only logged in, pass the vault
  state to `<ModuleHostProvider unlocked={...}>`. Then queries that need the
  vault pause instead of failing with 423, `useVaultUnlocked()` and
  `<WhenUnlocked fallback={...}>` let a page show locked and unlocked parts,
  and on lock the cached results of vault queries are cleared, so
  decrypted data doesn't stay on screen. `createWebHost({ onVaultLocked })`
  is called on any 423, for re-checking vault state.
- **`useContractVersionCheck()`** compares the contracts this bundle was
  built against with the server's `/_manifest`. A mismatch usually means a
  stale tab after a deploy, so prompt a reload.

### Shared components

A module can offer UI to others, not just data hooks. Declare it in the
contract as `component<Props>()`. The web module implementing the contract
must provide it (`define({ components: { PersonPicker } })`, checked by
types and at boot). Others use it like this:

```tsx
<inbox.Component of={peopleContract.components.PersonPicker} prompt="Who is it?" onPick={...} />
// or, as a hook: const PersonPicker = inbox.useComponent(peopleContract.components.PersonPicker);
```

Props are typed from the contract either way. The element form is the
one to reach for in JSX. The hook returns a stable component (cached per
reference by the host), but lint rules can't know that.

The consumer depends on the contract, never on the provider's code, so the
provider stays swappable. Using a component of a contract you didn't
require is a type error. Each component renders inside its own error
boundary. If no installed web module implements it (e.g. a backend-only
install of that contract), it renders `null`. Type the implementation with
`ComponentPropsOf<typeof contract.components.X>`.

**Slot or component?** A slot is "everyone may add something here"; the
owner of the page decides where. A component is "here's a thing you can
put anywhere"; the consumer decides where, and there's exactly one
implementation.

## Live updates

Events marked `live: true` are pushed over a WebSocket
(`<prefix>/_live`) to **the emitting user's** open tabs:

- **Server:** on by default (needs `@fastify/websocket`; the host reuses an
  existing root registration if the app has one). With `requireCaller` the
  socket opens once logged in; without it, it needs an unlocked vault.
  - Each socket gets `{ type: "vault", unlocked }` when it connects and
    whenever that changes. With `vaultEvents` (vault-service's
    `sessionCache.onChange`) the change is pushed right away. Otherwise
    it's noticed at the next push or heartbeat (`live.heartbeatMs`,
    default 30 s).
  - Events and job updates go only to unlocked sockets, since they can
    carry decrypted content. A socket stays open across lock and unlock.
  - Set `live.origins`: browsers send cookies with WebSocket handshakes and
    CORS doesn't apply.
- **Browser:** mount `<LiveConnection onVaultChange={...} />` once logged in
  (or where the vault is unlocked, without `requireCaller`). `onVaultChange`
  hears about locks and unlocks, e.g. to re-check vault state. An
  incoming event is validated against the contract, then the queries in
  its `invalidates` are refetched. That alone covers most live UI, with no
  code. For custom reactions use `mod.useLiveEvent(contract, "renamed",
  payload => ...)`, typed and visibility-checked. The client reconnects
  with backoff, and after a reconnect or an unlock it refetches every live
  contract's queries, since events may have been missed. `useLiveStatus()` reports
  the connection state.
- Only events are pushed, never query results. A push says "this
  changed"; clients refetch through the normal validated RPC path.

## Background jobs

A module declares its job types and handles them in `setup`:

```ts
defineServerModule({
  id: "journal",
  jobs: { extract: z.object({ entryId: z.number() }) },
  setup(ctx) {
    ctx.jobs.handle("extract", async (call, { entryId }) => { ... });   // call = journal's own context
    ctx.on(journalContract, "entryCreated", (call, e) => ctx.jobs.enqueue(call, "extract", { entryId: e.id }));
  },
});
```

- **Queue:** one host-owned table, `__module_jobs`, created by
  `migrate()`. Payloads are encrypted with the module's own vault scope
  (context `job:<name>`), so they're as protected at rest as the module's
  tables. Enqueueing needs the caller's vault unlocked.
- **Private to the module:** job types aren't in the contract. Other
  modules trigger work through commands or events.
- **Runner:** `host.jobs.start({ pollMs })`, or `host.jobs.runDue()` in
  tests. Jobs run one at a time.
  - If the job's session vault is locked, the job waits (deferred 30s, not
    counted as an attempt).
  - Failures retry with backoff (1s, 2s, 4s…) up to `maxAttempts`
    (default 3). Only the error's class name is stored, never its message,
    which could echo decrypted content.
  - `onJob` reports every outcome.
  - On start, jobs a crash left `running` are requeued.
- **Every declared job needs a handler**, checked at boot.
- **"Not now":** a handler throws `JobDeferredError(retryInMs)` when a
  dependency is down rather than the job being broken (an AI answering
  503, say). The job is requeued that much later without counting an
  attempt, so an outage of any length doesn't use up its retries. It just
  waits, like a job waiting for an unlock. Plain errors still back off
  (2s, 4s, ...) and fail after `maxAttempts`.
- **`ctx.jobs.pendingCount(userId, name?)`**: how many of the module's jobs
  are queued or running, e.g. to skip a catch-up run while work is in
  flight.
- **Schedules:** `schedules: { nightly: { job: "sweep", everyMs: 86_400_000,
  payload } }`. Each user with an unlocked session (host option
  `activeCallers`, e.g. vault-service's `sessionCache.unlockedSessions()`)
  gets the job enqueued once per period, as themselves. Someone who isn't
  around catches up on their next unlock. Runs as part of the job runner's
  tick.
- **Visibility:** each module with jobs serves `GET /<module>/_jobs` (the
  caller's own recent jobs: name, status, attempts, error class; never
  payloads). The web side reads it with `mod.useJobs(contract)`. Every
  enqueue and outcome pushes a `{ type: "jobs", module }` live message, so
  that list refreshes by itself.

## Modules in other processes

Where a module runs is a composition choice. A host can install some
modules and reach others in another process, e.g. an AI module that has
to run where the GPU or Ollama is reachable. It all goes over one internal
channel:

```ts
// worker process: runs `ai` (and maybe some modules' jobs), serves it to the API
const worker = createServerHost({
  modules: [ai], db, live: false,
  internal: { secret },                                    // serve worker.internalRoutes
  liveRelay: { url: `${API}/internal/m`, secret },         // live events reach the browsers
  vaultFor: remote.vaultFor, prepareVault: remote.prepare, // vault-service createRemoteVault
  requireVault: () => undefined,
});
app.register(worker.internalRoutes, { prefix: "/internal/m" });

// API: journal requires aiContract; calls go over the wire, transparently
const api = createServerHost({
  modules: [journal], db, internal: { secret },
  remotes: [{ url: `${WORKER}/internal/m`, secret, contracts: [aiContract] }],
  ...
});
app.register(api.internalRoutes, { prefix: "/internal/m" });   // receives relayed live events
```

- **Remote providers count for composition.** A contract-only requirement
  is satisfied by a `remotes` entry, with the same version check. At call
  time the contract version travels in a header, and a mismatch is a 409
  rather than a misread.
- **Calls carry the caller.** The remote host builds the call context with
  *its own* vault scope for that session (`prepareVault` +
  `createRemoteVault`), so isolation holds across processes. Handler
  errors come back as `OperationError` with the same status; a locked vault
  comes back as `ModuleVaultLockedError`; validation runs on both ends.
- **`internalRoutes` is secret-gated** (constant-time comparison) and is
  meant for a private network. Mount it outside your cookie-auth routes.
- **Jobs in another process:** a host only claims jobs of the modules it
  installs, so a worker can run a subset. Only **named scopes** cross
  processes; `call.legacy` throws in a worker, so jobs over pre-scope data
  stay in the API process. Run each module's jobs in one process only,
  because crash recovery requeues `running` jobs of the modules a runner
  hosts.
- **Not yet:** events from one process reaching *subscriber modules* in
  another. Only the live push to browsers is relayed.

## Authorization and IAM

Every operation is an **action**: `module:operation` (`notes:list`,
`notes:create`). Jobs are `module:job`, and a contract can declare extra
`actions` for custom routes or pages. `host.actions()` lists them all.

- **Enforcement is in the host.** With the `authorize(caller, action)` host
  option, every operation call is checked as the calling user: from the
  browser, in-process from another module, and over the internal channel.
  Every job run is checked too, at run time, so revoking access stops queued
  work. A denied call is an `OperationError(403)`. Without the option,
  everything is allowed (Ebba). Worker processes need the same `authorize`.
  - Strict means transitive: if a page's module calls `people.labels` for
    you, you need `people:labels` too. Wildcards make this manageable.
- **Browser:** `<AccessProvider can ready>` feeds `useCan(action)`,
  `<IfCan>`, the nav (items whose page has a denied `action` drop out) and
  `<RouterOutlet forbidden>`. Denied queries pause instead of failing. This
  is UX only; the server decides.
- **Built-in IAM** (`@hakeee/module-host/iam`, `/iam/server`, `/iam/web`)
  is an optional module, modeled on AWS IAM:
  - Users get roles, roles get policies. A policy is
    `{ version: 1, statements: [{ effect, actions, notActions?, kind?, resources? }] }`.
    Wildcards work anywhere and matching is case-insensitive. An explicit
    deny beats any allow, and anything not allowed is denied.
  - `kind: "query" | "command"` narrows a statement to reads or writes.
  - **Records.** `resources` (`clients:client/42`, `clients:client/*`) and
    `conditions` (`{ "clients:trainers": "${user.id}" }`) scope a statement
    to some records. A contract declares its record types
    (`resources: { client: { attributes: ["trainers"] } }`), an operation
    that checks records says `resource: "client"`, and its handler checks
    each one with `ctx.can(call, action, contract.resources.client.of(id,
    attributes))` or `ctx.filter(...)`, redacting rather than failing where
    a record appears inside something else.
    - For the operation itself, a scoped *allow* lets a record-checking
      operation run; on any other operation scoped statements are ignored,
      so they can't open up code that doesn't check records, and a scoped
      deny never blocks a whole operation.
    - A condition matches when any attribute value equals any listed value;
      all conditions must match; a missing attribute never matches.
      `${user.id}` is the only variable, and saving a policy rejects
      statements that could never match.
    - `iam.resources` lists record types for editors; `iam.actions` marks
      record-checking actions. The browser's `useCan` answers for the
      operation only; record checks are the server's.
  - Managed policies: AdministratorAccess (`*`) and ReadOnlyAccess (every
    query except IAM's). Starter roles `admin` and `member` are created on a
    fresh install and are ordinary data afterwards.
  - Root is the first account (or `rootEmail`) and is always allowed
    everything. `iam:myAccess` is always allowed.
  - IAM's tables are plain data (checked while locked, edited by admins for
    others). Its reads are `vault: false`; its changes need an unlocked vault,
    so a stolen cookie can't grant itself access.
  - Apps can add their own managed policies (`policies`, kept matching the
    code on every boot, not editable in the UI) and replace the starter
    roles (`starterRoles`, fresh installs only, policies must be managed),
    e.g. an `admin` role without IAM rights.
  - `createIam({ accounts, rootEmail?, defaultRoles?, policies?, starterRoles?, oidc?, invites? })` returns
    `{ module, authorize, onLogin }`. `accounts` is vault-service's
    `createAccountStore(db)`, minus `create` (password accounts) for OIDC.
  - **Invites:** with `accounts.invite` and `invites: { link(token), send? }`,
    `iam:createUser` without a password creates the account with no login and
    a one-time link; `iam:invite` makes a new link, `iam:revokeInvite` cancels
    it. `send` emails the link as the admin (the app's mail module); without
    it, or when it fails, the admin is shown the link once to pass on.
    `users` reports `login`, `mfa` and the latest `invite`'s state.
  - **Roles at the IdP:** with `oidc` and `accounts.setIdpRoles`, roles picked
    in the admin UI (invite, `setUserRoles`) are granted at the IdP (each IAM
    role through the first IdP role mapping to it; unmapped roles are refused)
    and stored as source `oidc`, replacing manual ones. The next login's
    claims still decide. Accounts without an IdP login keep manual roles.
  - `onLogin` (from vault-service's `createAuthRoutes`) maps IdP roles to
    IAM roles at each login (`oidc.roleMap`; the Zitadel roles claim by
    default) and gives signups `defaultRoles`.
  - `/m` answers unexpected errors with a bare 500 (`internal error`, the
    details go to `logError`), and operation names from the URL are looked
    up without the prototype (`/rpc/constructor` is a 404).
  - The web part is headless (`<IamAccess>`, `useRefreshAccess`). Apps build
    the admin pages for `iamContract.pages` themselves, like they build
    their auth screens.
  - Admin actions on other accounts: `iam:disableUser` / `enableUser`,
    `iam:resetPassword` (login password only; a vault passphrase can't be
    reset), `iam:revokeSessions`, `iam:resetMfa` (their second factors; not
    your own). They never apply to root, and you can't
    disable yourself. Each needs the matching `accounts` method
    (vault-service's account store has them all).
  - **Self-service actions** (kind `self-service`, passed to the host as
    `extraActions`, e.g. vault-service's `SELF_SERVICE_ACTIONS`) are allowed
    unless a policy explicitly denies them, so people can manage their own
    security by default. Pass the same `authorize` to vault-service's routes.
    `myAccess.selfService` tells the UI which are denied
    (`useAccessState` / `useCan`).
  - Permissions decide what someone may *do*. They can't open another
    user's vault: encrypted data stays readable only by its owner, root
    included.
  - **Audit trail**: the host's `onOperation(event)` hears about every
    operation a browser calls, after it ran: `{ caller, action, kind,
    input, outcome, status, ip }`, outcome `ok` / `denied` / `invalid` /
    `not-found` / `error`. Refusals before the operation (401, 423) and
    in-process calls between modules aren't reported. `input` is the raw
    body: keep ids from it, never all of it. Storing the events is the
    app's business. Invites made without a name get the email's local part
    (`nameFromEmail`), never the address.

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
