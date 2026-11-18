import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// vault-service's `user` table, redeclared for the foreign keys only (not
// exported, so drizzle-kit doesn't generate it - vault-service owns it).
const user = sqliteTable("user", { id: integer("id").primaryKey() });

/** Plain data on purpose: checked on every call, locked or not, and edited by admins for other users. */
export const iamPolicy = sqliteTable("iam_policy", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  document: text("document").notNull(), // JSON PolicyDocument
  managed: integer("managed", { mode: "boolean" }).notNull().default(false),
});

export const iamRole = sqliteTable("iam_role", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
});

export const iamRolePolicy = sqliteTable(
  "iam_role_policy",
  {
    role: text("role").notNull().references(() => iamRole.name),
    policy: text("policy").notNull().references(() => iamPolicy.name),
  },
  (t) => [primaryKey({ columns: [t.role, t.policy] })],
);

export const iamUserRole = sqliteTable(
  "iam_user_role",
  {
    userId: integer("user_id").notNull().references(() => user.id),
    role: text("role").notNull().references(() => iamRole.name),
    /** "manual" (given in the admin UI) or "oidc" (mapped from the IdP at each login). */
    source: text("source", { enum: ["manual", "oidc"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role, t.source] })],
);

/** The one root account: always allowed everything, like AWS's root user. */
export const iamRoot = sqliteTable("iam_root", {
  userId: integer("user_id").primaryKey().references(() => user.id),
});
