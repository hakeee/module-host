import type { PageRef } from "../contract.js";

/** Where the router reads and writes the location. `browserHistory()` in apps, `memoryHistory()` in tests. */
export interface RouterHistory {
  location(): string;
  push(path: string): void;
  replace(path: string): void;
  subscribe(listener: () => void): () => void;
}

export function browserHistory(): RouterHistory {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  window.addEventListener("popstate", notify);
  return {
    location: () => window.location.pathname + window.location.search,
    push(path) {
      window.history.pushState(null, "", path);
      notify();
    },
    replace(path) {
      window.history.replaceState(null, "", path);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function memoryHistory(initial = "/"): RouterHistory & { entries: string[] } {
  const listeners = new Set<() => void>();
  const entries = [initial];
  return {
    entries,
    location: () => entries[entries.length - 1]!,
    push(path) {
      entries.push(path);
      listeners.forEach((l) => l());
    },
    replace(path) {
      entries[entries.length - 1] = path;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface CompiledRoute {
  page: PageRef;
  keys: string[];
  pattern: RegExp;
  staticSegments: number;
}

export function compileRoute(page: PageRef): CompiledRoute {
  const keys: string[] = [];
  let staticSegments = 0;
  const source = page.path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      staticSegments += 1;
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { page, keys, pattern: new RegExp(`^/${source}/?$`), staticSegments };
}

/** Most specific first: more static segments win, so `/people/new` beats `/people/:id`. */
export function sortRoutes(routes: CompiledRoute[]): CompiledRoute[] {
  return [...routes].sort((a, b) => b.staticSegments - a.staticSegments || a.keys.length - b.keys.length);
}

export function matchRoute(routes: readonly CompiledRoute[], location: string) {
  const pathname = location.split("?")[0]!.split("#")[0]!;
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const raw = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
    return { route, raw };
  }
  return undefined;
}

export function buildHref(page: PageRef, params: Record<string, unknown> | undefined): string {
  return page.path.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined || value === null) throw new Error(`page "${page.contractId}.${page.name}" needs param "${key}"`);
    return encodeURIComponent(String(value));
  });
}
