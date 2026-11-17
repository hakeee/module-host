import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { isContract } from "../contract.js";
import { ModuleCompositionError } from "../resolve.js";

export interface TableOwner {
  readonly id: string;
  readonly schema: Readonly<Record<string, unknown>> | undefined;
  readonly legacyTableNames: readonly string[] | undefined;
  readonly requires: readonly unknown[];
}

export function tablesOf(schema: Readonly<Record<string, unknown>> | undefined): SQLiteTable[] {
  return Object.values(schema ?? {}).filter((value): value is SQLiteTable => is(value, SQLiteTable));
}

/**
 * Database isolation rules, checked at boot:
 *
 * 1. Every table belongs to exactly one module.
 * 2. Its name starts with `<module id>_` (hyphens as underscores), unless
 *    listed in the module's `legacyTableNames` - for tables that existed
 *    before the module did, where renaming would mean migrating live data.
 * 3. Foreign keys may only point at the module's own tables, at tables of
 *    modules it requires *as modules* (those are always installed with
 *    it), or at the host's `sharedTables` (e.g. vault-service's `user`).
 *    Requiring only a contract doesn't allow FKs: its implementation could
 *    be swapped out, so reference its data by id through the contract.
 */
export function checkTables(modules: readonly TableOwner[], sharedTables: readonly string[]): void {
  const ownerOf = new Map<string, string>();
  for (const module of modules) {
    for (const table of tablesOf(module.schema)) {
      const { name } = getTableConfig(table);
      const owner = ownerOf.get(name);
      if (owner) throw new ModuleCompositionError(`table "${name}" is claimed by both "${owner}" and "${module.id}"`);
      if (sharedTables.includes(name)) {
        throw new ModuleCompositionError(`"${module.id}" claims "${name}", which is a host shared table`);
      }
      ownerOf.set(name, module.id);

      const prefix = `${module.id.replaceAll("-", "_")}_`;
      if (!name.startsWith(prefix) && !module.legacyTableNames?.includes(name)) {
        throw new ModuleCompositionError(
          `"${module.id}" table "${name}" must be named "${prefix}..." (or listed in legacyTableNames)`,
        );
      }
    }
  }

  const byId = new Map(modules.map((m) => [m.id, m]));
  for (const module of modules) {
    const allowedOwners = new Set([module.id]);
    for (const requirement of module.requires) {
      if (!isContract(requirement)) allowedOwners.add((requirement as { id: string }).id);
    }
    for (const table of tablesOf(module.schema)) {
      const config = getTableConfig(table);
      for (const fk of config.foreignKeys) {
        const target = getTableConfig(fk.reference().foreignTable).name;
        if (sharedTables.includes(target)) continue;
        const targetOwner = ownerOf.get(target);
        if (targetOwner && allowedOwners.has(targetOwner)) continue;
        const why = targetOwner
          ? byId.get(targetOwner) && `"${module.id}" doesn't require module "${targetOwner}"`
          : `no module owns "${target}"`;
        throw new ModuleCompositionError(`"${module.id}" table "${config.name}" has a foreign key to "${target}": ${why}`);
      }
    }
  }
}
