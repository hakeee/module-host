import { useCallback, useMemo, type ReactNode } from "react";
import { actionsOf } from "../contract.js";
import { AccessProvider, useWebHost, webModule } from "../web/index.js";
import { iamContract } from "./contract.js";
import { evaluate, type ActionMeta } from "./policy.js";

// Only for data hooks; never installed (the app installs its own web module
// for iamContract, with the admin pages).
const access = webModule({ id: "iam-access", requires: [iamContract] });

/**
 * Loads the user's permissions (`iam.myAccess`, which works while locked)
 * and provides them to `useCan`, `<IfCan>`, nav filtering and page
 * `action`s. Put it inside `<ModuleHostProvider>`. Hiding is only for UX:
 * the server checks every call regardless.
 */
export function IamAccess({ children }: { children: ReactNode }) {
  const host = useWebHost();
  const me = access.useModule(iamContract).queries.myAccess.useQuery({}, { staleTime: 30_000 });
  const info = useMemo(() => {
    const map = new Map<string, ActionMeta>();
    for (const contract of host.contracts.values()) for (const a of actionsOf(contract)) map.set(a.action, { kind: a.kind, resource: a.resource });
    return map;
  }, [host]);
  const data = me.data;
  const can = useCallback(
    (action: string) => {
      if (data === undefined) return false;
      if (data.root) return true;
      // Self-service actions aren't in any contract; the server says which are denied.
      const selfService = data.selfService.find((s) => s.action === action);
      // Operation level: whether the action may run at all (record checks happen on the server).
      return selfService ? selfService.allowed : evaluate(data.statements, action, (a) => info.get(a), { userId: data.userId });
    },
    [data, info],
  );
  return (
    <AccessProvider can={can} ready={me.isSuccess}>
      {children}
    </AccessProvider>
  );
}

/** Refetch the current user's permissions, e.g. after changing roles. */
export function useRefreshAccess(): () => Promise<void> {
  return access.useModule(iamContract).queries.myAccess.invalidate;
}
