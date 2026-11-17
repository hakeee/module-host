import { isContract, type AnyContract } from "./contract.js";

/** What both server and web modules share for composition. */
export interface ComposableModule {
  readonly id: string;
  readonly contract: AnyContract | undefined;
  /** Modules (pulled in automatically) or bare contracts (someone else must provide them). */
  readonly requires: readonly (ComposableModule | AnyContract)[];
}

export class ModuleCompositionError extends Error {}

/**
 * Expands `roots` with everything they transitively require, checks the
 * graph, and returns modules in dependency order (requirements first).
 *
 * - Requiring a module pulls it in; requiring a bare contract doesn't, and
 *   (with `requireProviders`, i.e. on the server) some module in the final
 *   set must implement it. The web side can't demand that: a UI-only module
 *   over a backend-only contract has no web-side implementation to find.
 * - Ids are unique; a contract has exactly one implementation per side.
 * - A required contract's `version` must equal its implementation's.
 * - `requires` must be acyclic (events can still flow both ways).
 */
export function resolveModules<M extends ComposableModule>(
  roots: readonly M[],
  side: string,
  options: { requireProviders: boolean; externalContracts?: readonly AnyContract[] } = { requireProviders: true },
): M[] {
  const ordered: M[] = [];
  const state = new Map<M, "visiting" | "done">();

  const visit = (module: M, path: string[]) => {
    const seen = state.get(module);
    if (seen === "done") return;
    if (seen === "visiting") {
      throw new ModuleCompositionError(`${side}: dependency cycle ${[...path, module.id].join(" -> ")}`);
    }
    state.set(module, "visiting");
    for (const requirement of module.requires) {
      if (!isContract(requirement)) visit(requirement as M, [...path, module.id]);
    }
    state.set(module, "done");
    ordered.push(module);
  };
  for (const root of roots) visit(root, []);

  const byId = new Map<string, M>();
  const providers = new Map<string, M>();
  for (const module of ordered) {
    const existing = byId.get(module.id);
    if (existing && existing !== module) {
      throw new ModuleCompositionError(`${side}: two different modules use the id "${module.id}"`);
    }
    byId.set(module.id, module);
    if (module.contract) {
      const other = providers.get(module.contract.id);
      if (other) {
        throw new ModuleCompositionError(
          `${side}: contract "${module.contract.id}" is implemented by both "${other.id}" and "${module.id}"`,
        );
      }
      providers.set(module.contract.id, module);
    }
  }

  for (const module of ordered) {
    for (const requirement of module.requires) {
      const contract = isContract(requirement) ? requirement : requirement.contract;
      if (!contract) continue;
      const provider = providers.get(contract.id);
      if (!provider) {
        const external = options.externalContracts?.find((c) => c.id === contract.id);
        if (external) {
          if (external.version !== contract.version) {
            throw new ModuleCompositionError(
              `${side}: "${module.id}" was built against "${contract.id}" v${contract.version}, but the remote declares v${external.version}`,
            );
          }
          continue;
        }
        if (!options.requireProviders) continue;
        throw new ModuleCompositionError(
          `${side}: "${module.id}" requires contract "${contract.id}", but no module implements it`,
        );
      }
      if (provider.contract!.version !== contract.version) {
        throw new ModuleCompositionError(
          `${side}: "${module.id}" was built against "${contract.id}" v${contract.version}, ` +
            `but "${provider.id}" implements v${provider.contract!.version}`,
        );
      }
    }
  }

  return ordered;
}

/** The contracts a module may use: its own plus everything it requires directly. */
export function visibleContracts(module: ComposableModule): Set<string> {
  const ids = new Set<string>();
  if (module.contract) ids.add(module.contract.id);
  for (const requirement of module.requires) {
    const contract = isContract(requirement) ? requirement : requirement.contract;
    if (contract) ids.add(contract.id);
  }
  return ids;
}
