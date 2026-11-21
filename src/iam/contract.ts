import { z } from "zod";
import { defineContract } from "../contract.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "letters, digits, _ . - (max 64)");

export const policyStatementSchema = z.object({
  effect: z.enum(["allow", "deny"]),
  actions: z.array(z.string().min(1)).min(1),
  notActions: z.array(z.string().min(1)).optional(),
  kind: z.enum(["query", "command"]).optional(),
  resources: z.array(z.string().min(1)).optional(),
  conditions: z.record(z.string().min(1), z.union([z.string(), z.array(z.string())])).optional(),
});

export const policyDocumentSchema = z.object({
  version: z.literal(1),
  statements: z.array(policyStatementSchema),
});

const none = z.object({});

/**
 * A new invite. `link` is only returned when it wasn't emailed, for the
 * admin to pass on; once the app sends it, nobody but the invitee sees it.
 */
const inviteSchema = z.object({ link: z.string().nullable(), expiresAt: z.string(), emailed: z.boolean() });

/**
 * The built-in IAM module's surface. Reads are `vault: false` (it's plain
 * data, and the UI needs permissions while locked); changes need an
 * unlocked vault, so a stolen session cookie alone can't grant itself
 * access. Every operation is itself an action (`iam:putRole`, ...).
 */
export const iamContract = defineContract({
  id: "iam",
  version: 1,
  queries: {
    /** The caller's own effective permissions. Always allowed, so any UI can ask. */
    myAccess: {
      input: none,
      output: z.object({
        userId: z.number(),
        root: z.boolean(),
        statements: z.array(policyStatementSchema),
        /** Self-service actions (allowed unless denied) and whether this user may take them. */
        selfService: z.array(z.object({ action: z.string(), allowed: z.boolean() })),
      }),
      vault: false,
    },
    users: {
      input: none,
      output: z.array(
        z.object({
          id: z.number(),
          email: z.string(),
          displayName: z.string(),
          root: z.boolean(),
          disabled: z.boolean(),
          /** Has a way to log in (a password or an IdP login). False while an invite is open. */
          login: z.boolean(),
          /** Has a second login factor; null where the accounts don't track it. */
          mfa: z.boolean().nullable(),
          /** Their latest invite, if they were invited. */
          invite: z.object({ state: z.enum(["pending", "expired", "accepted", "revoked"]), expiresAt: z.string() }).nullable(),
          roles: z.array(z.object({ name: z.string(), source: z.enum(["manual", "oidc"]) })),
        }),
      ),
      vault: false,
    },
    roles: {
      input: none,
      output: z.array(z.object({ name: z.string(), description: z.string(), policies: z.array(z.string()) })),
      vault: false,
    },
    policies: {
      input: none,
      output: z.array(z.object({ name: z.string(), description: z.string(), managed: z.boolean(), document: policyDocumentSchema })),
      vault: false,
    },
    /** Every action the installed modules define, for policy editors. */
    /** Record types policies can be scoped to, with the attributes conditions may test. */
    resources: {
      input: none,
      output: z.array(z.object({ type: z.string(), description: z.string().optional(), attributes: z.array(z.string()) })),
      vault: false,
    },
    actions: {
      input: none,
      output: z.array(
        z.object({ action: z.string(), kind: z.enum(["query", "command", "job", "declared", "self-service"]), resource: z.string().optional() }),
      ),
      vault: false,
    },
    /** What this install supports, e.g. creating accounts (not in OIDC mode). */
    settings: {
      input: none,
      output: z.object({
        canCreateUsers: z.boolean(),
        canDisableUsers: z.boolean(),
        canResetPasswords: z.boolean(),
        canRevokeSessions: z.boolean(),
        /** Accounts can be created by invite (a one-time link the person opens). */
        canInvite: z.boolean(),
        /** The app emails invite links itself; otherwise the admin passes the link on. */
        emailsInvites: z.boolean(),
        canResetMfa: z.boolean(),
        /** OIDC: roles set here are granted at the identity provider too (see `IamAccounts.setIdpRoles`). */
        rolesAtIdp: z.boolean(),
      }),
      vault: false,
    },
  },
  commands: {
    /**
     * Without `password`, the account is created by invite: no login until
     * the person opens the link (single mode: sets a password; OIDC: logs in
     * at the IdP). With one, a temporary password the person changes later.
     */
    createUser: {
      input: z.object({
        email: z.email(),
        password: z.string().min(8, "at least 8 characters").optional(),
        displayName: z.string().optional(),
        roles: z.array(z.string()),
      }),
      output: z.object({ id: z.number(), invite: inviteSchema.optional() }),
    },
    /** A fresh invite link for someone who hasn't accepted theirs yet (the old one stops working). */
    invite: { input: z.object({ userId: z.number() }), output: inviteSchema },
    revokeInvite: { input: z.object({ userId: z.number() }), output: none },
    /** Removes their second factors; they set one up again at their next login. Not root, not yourself. */
    resetMfa: { input: z.object({ userId: z.number() }), output: none },
    /** No logins; their sessions end everywhere. Not root, not yourself. */
    disableUser: { input: z.object({ userId: z.number() }), output: none },
    enableUser: { input: z.object({ userId: z.number() }), output: none },
    /** Log them out everywhere. */
    revokeSessions: { input: z.object({ userId: z.number() }), output: none },
    /** A new (temporary) login password. Their vault passphrase can't be reset - only their recovery key restores that. */
    resetPassword: { input: z.object({ userId: z.number(), password: z.string().min(8, "at least 8 characters") }), output: none },
    /** Replaces the user's manually given roles; roles from OIDC are managed at login. */
    setUserRoles: { input: z.object({ userId: z.number(), roles: z.array(z.string()) }), output: none },
    putRole: { input: z.object({ name, description: z.string().default(""), policies: z.array(z.string()) }), output: none },
    deleteRole: { input: z.object({ name: z.string() }), output: none },
    putPolicy: { input: z.object({ name, description: z.string().default(""), document: policyDocumentSchema }), output: none },
    deletePolicy: { input: z.object({ name: z.string() }), output: none },
  },
  pages: {
    users: { path: "/access/users", params: none, action: "users" },
    roles: { path: "/access/roles", params: none, action: "roles" },
    policies: { path: "/access/policies", params: none, action: "policies" },
  },
});
