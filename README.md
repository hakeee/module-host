# module-host

Compose an app out of isolated feature modules that interact only through
typed contracts. Composition happens at build time and everything runs in
one process. It covers both sides:

- **`@hakeee/module-host`**: `defineContract`, `slot`, `OperationError`,
  Standard Schema helpers.
- **`@hakeee/module-host/server`**: `defineServerModule`,
  `createServerHost`, `migrateModules`. Built on Fastify, Drizzle
  (better-sqlite3) and `@hakeee/vault-service` scopes.
- **`@hakeee/module-host/web`**: `webModule`, `createWebHost`,
  `ModuleHostProvider`, `RouterOutlet`, `Link`, `Slot`, `EntityLink`,
  `useNav`. Built on React 19 and TanStack Query.

Read **[DESIGN.md](./DESIGN.md)** first. It covers what a module is, the
contract format, the database and encryption rules, and the linked-repo
caveats.

## Minimal wiring

```ts
// server
const host = createServerHost({
  modules: [people, journal],
  db,
  sharedTables: ["user"],
  requireVault: createRequireVault(sessionCache),
  vaultFor: (id) => sessionCache.getVault(id),
});
migrateVaultService(db); host.migrate(); /* then the app's own migrations */
app.register(async (protectedRoutes) => {
  protectedRoutes.addHook("onRequest", requireAuth);
  protectedRoutes.register(host.routes, { prefix: "/m" });
});

// web
const host = createWebHost({ modules: [appWeb], baseUrl: `${API}/m` });
<ModuleHostProvider host={host}><Shell /></ModuleHostProvider>  // Shell renders useNav() + <RouterOutlet />
```

Consumers: Ebba (`modules/people`, plus its legacy screens as one module).
See `ROADMAP.md`.
