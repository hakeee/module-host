// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { AccessProvider, IfCan, ModuleHostProvider, RouterOutlet, createWebHost, memoryHistory, useNav, webModule } from "./index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const adminContract = defineContract({
  id: "admin",
  version: 1,
  queries: { stats: { input: z.object({}), output: z.number() } },
  pages: {
    home: { path: "/", params: z.object({}) },
    panel: { path: "/panel", params: z.object({}), action: "panel" },
  },
  actions: ["panel"],
});
expect(adminContract.pages.panel.action).toBe("admin:panel");
expect(adminContract.actions).toEqual(["admin:panel"]);

const admin = webModule({ contract: adminContract });
function Home() {
  const stats = admin.useModule(adminContract).queries.stats.useQuery({});
  return (
    <main>
      <span data-testid="stats">{stats.data ?? (stats.fetchStatus === "idle" ? "paused" : "-")}</span>
      <IfCan action="admin:panel" fallback={<span data-testid="nope">no panel</span>}>
        <span data-testid="yes">panel link</span>
      </IfCan>
    </main>
  );
}
function Nav() {
  return <nav data-testid="nav">{useNav().map((i) => i.label).join(",")}</nav>;
}
const adminWeb = admin.define({
  pages: { home: Home, panel: () => <main data-testid="panel">panel</main> },
  nav: [
    { label: "Home", to: adminContract.pages.home },
    { label: "Panel", to: adminContract.pages.panel },
  ],
});

let container: HTMLDivElement;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function mount(path: string, can: (action: string) => boolean, ready = true) {
  const fetch = vi.fn(async () => new Response("42"));
  const host = createWebHost({ modules: [adminWeb], baseUrl: "https://api.test/m", history: memoryHistory(path), fetch: fetch as never });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ModuleHostProvider host={host}>
          <AccessProvider can={can} ready={ready}>
            <Nav />
            <RouterOutlet notFound={<span data-testid="missing">missing</span>} forbidden={<span data-testid="forbidden">forbidden</span>} />
          </AccessProvider>
        </ModuleHostProvider>
      </QueryClientProvider>,
    ),
  );
  const text = (id: string) => container.querySelector(`[data-testid=${id}]`)?.textContent;
  return { fetch, text };
}

describe("access", () => {
  it("hides denied pages from the nav and the outlet, pauses denied queries, and gates IfCan", async () => {
    const { text } = mount("/panel", (a) => a === "admin:stats");
    expect(text("nav")).toBe("Home");
    expect(text("forbidden")).toBe("forbidden");
    act(() => root!.unmount());
    root = undefined;

    const denied = mount("/", () => false);
    expect(denied.text("stats")).toBe("paused");
    expect(denied.text("nope")).toBe("no panel");
    expect(denied.fetch).not.toHaveBeenCalled();
  });

  it("shows everything allowed, and renders nothing gated while permissions load", async () => {
    const allowed = mount("/", () => true);
    expect(allowed.text("nav")).toBe("Home,Panel");
    await vi.waitFor(() => expect(allowed.text("stats")).toBe("42"));
    expect(allowed.text("yes")).toBe("panel link");
    act(() => root!.unmount());
    root = undefined;

    const loading = mount("/panel", () => true, false);
    expect(loading.text("nav")).toBe("Home");
    expect(loading.text("panel")).toBeUndefined();
    expect(loading.text("forbidden")).toBeUndefined();
  });
});
