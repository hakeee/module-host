import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { createServerHost, defineServerModule, type ServerContext } from "../server/index.js";
import { createIam } from "./server.js";

describe("IAM privacy hooks", () => {
  it("exports a user's roles and removes them on erasure, never root's", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE user (id INTEGER PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL)");
    for (const email of ["root@x", "t@x"]) sqlite.prepare("INSERT INTO user (email, display_name) VALUES (?, ?)").run(email, email);
    let privacy: ServerContext<any, any, any>["privacy"] | undefined;
    const probe = defineServerModule({ id: "probe", setup: (ctx) => void (privacy = ctx.privacy) });
    const iam = createIam({ accounts: { list: () => [] } });
    const host = createServerHost({
      modules: [iam.module, probe],
      db: drizzle(sqlite),
      sharedTables: ["user"],
      vaultFor: () => undefined,
      requireVault: (_r, reply) => void reply.code(401).send({}),
      requireCaller: (_r, reply) => void reply.code(401).send({}),
      authorize: iam.authorize,
      requirePrivacy: true, // the IAM module itself passes the boot check
    });
    host.migrate();
    const root = { userId: 1, sessionId: "s1" };
    iam.authorize(root, "x"); // seeds the starter roles and makes user 1 root
    // (setUserRoles needs an unlocked vault; the row is what matters here.)
    sqlite.prepare("INSERT INTO iam_user_role (user_id, role, source) VALUES (2, 'member', 'manual')").run();

    expect(await privacy!.run("export", root, "user", 2)).toEqual([{ module: "iam", result: { root: false, roles: [{ role: "member", source: "manual" }] } }]);
    expect(await privacy!.run("erase", root, "user", 2)).toEqual([{ module: "iam", result: { removed: 1 } }]);
    expect(iam.authorize({ userId: 2, sessionId: "s2" }, "notes:list")).toBe(false);
    await expect(privacy!.run("erase", root, "user", 1)).rejects.toMatchObject({ status: 400 });
  });
});
