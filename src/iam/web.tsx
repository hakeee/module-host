import { useCallback, useMemo, type ReactNode } from "react";
import { actionsOf, type ActionKind } from "../contract.js";
import { AccessProvider, useWebHost, webModule } from "../web/index.js";
import { iamContract } from "./contract.js";
import { evaluate } from "./policy.js";

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
  const kinds = useMemo(() => {
    const map = new Map<string, ActionKind>();
    for (const contract of host.contracts.values()) for (const a of actionsOf(contract)) map.set(a.action, a.kind);
    return map;
  }, [host]);
  const data = me.data;
  const can = useCallback(
    (action: string) => data !== undefined && (data.root || evaluate(data.statements, action, (a) => kinds.get(a))),
    [data, kinds],
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
