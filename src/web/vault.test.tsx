// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { LiveConnection, ModuleHostProvider, RouterOutlet, WhenUnlocked, createWebHost, memoryHistory, webModule, type WebHost } from "./index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    act(() => this.onopen?.());
  }
  receive(message: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  close() {}
}

const accountContract = defineContract({
  id: "account",
  version: 1,
  queries: {
    me: { input: z.object({}), output: z.object({ email: z.string() }), vault: false },
    notes: { input: z.object({}), output: z.array(z.string()) },
  },
  events: { changed: { payload: z.object({}), live: true, invalidates: ["notes"] } },
  pages: { home: { path: "/", params: z.object({}) } },
});

const account = webModule({ contract: accountContract });

function HomePage() {
  const hooks = account.useModule(accountContract);
  const me = hooks.queries.me.useQuery({});
  const notes = hooks.queries.notes.useQuery({});
  return (
    <main>
      <span data-testid="me">{me.data?.email ?? "-"}</span>
      <span data-testid="notes">{notes.data?.join(",") ?? (notes.fetchStatus === "idle" ? "paused" : "-")}</span>
      <WhenUnlocked fallback={<span data-testid="locked">unlock to see this</span>}>
        <span data-testid="secret">secret</span>
      </WhenUnlocked>
    </main>
  );
}

const accountWeb = account.define({ pages: { home: HomePage } });

let container: HTMLDivElement;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  FakeSocket.instances = [];
});

function setup(options: { onVaultLocked?: () => void; status?: (url: string) => number } = {}) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url.split("/rpc/")[1]!);
    const status = options.status?.(url) ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ error: "vault locked" }), { status });
    return new Response(JSON.stringify(url.endsWith("/me") ? { email: "a@example.com" } : ["n1", "n2"]));
  });
  const host = createWebHost({
    modules: [accountWeb],
    baseUrl: "https://api.test/m",
    history: memoryHistory("/"),
    fetch: fetch as never,
    WebSocket: FakeSocket as never,
    onVaultLocked: options.onVaultLocked,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (unlocked: boolean, onVaultChange?: (u: boolean) => void) =>
    act(() =>
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ModuleHostProvider host={host as WebHost} unlocked={unlocked}>
            <LiveConnection onVaultChange={onVaultChange} />
            <RouterOutlet />
          </ModuleHostProvider>
        </QueryClientProvider>,
      ),
    );
  const text = (id: string) => container.querySelector(`[data-testid=${id}]`)?.textContent;
  return { calls, render, text, queryClient };
}

describe("locked vs unlocked", () => {
  it("runs vault: false queries while locked, pauses the rest, and shows WhenUnlocked's fallback", async () => {
    const { calls, render, text } = setup();
    render(false);
    await vi.waitFor(() => expect(text("me")).toBe("a@example.com"));
    expect(text("notes")).toBe("paused");
    expect(text("locked")).toBe("unlock to see this");
    expect(text("secret")).toBeUndefined();
    expect(calls).toEqual(["me"]);

    render(true);
    await vi.waitFor(() => expect(text("notes")).toBe("n1,n2"));
    expect(text("secret")).toBe("secret");
    expect(text("locked")).toBeUndefined();
  });

  it("drops cached results that needed the vault when it locks, and keeps the rest", async () => {
    const { render, text, queryClient } = setup();
    render(true);
    await vi.waitFor(() => expect(text("notes")).toBe("n1,n2"));

    render(false);
    expect(queryClient.getQueryData(["account", "notes", {}])).toBeUndefined();
    expect(queryClient.getQueryData(["account", "me", {}])).toEqual({ email: "a@example.com" });
    await vi.waitFor(() => expect(text("notes")).toBe("paused")); // off the screen too, not just the cache
  });

  it("calls onVaultLocked when a request comes back 423", async () => {
    const onVaultLocked = vi.fn();
    const { render } = setup({ onVaultLocked, status: (url) => (url.endsWith("/notes") ? 423 : 200) });
    render(true);
    await vi.waitFor(() => expect(onVaultLocked).toHaveBeenCalledOnce());
  });

  it("passes the socket's vault state to onVaultChange, and refetches live queries on unlock", async () => {
    const onVaultChange = vi.fn();
    const { render, queryClient } = setup();
    render(true, onVaultChange);
    const socket = FakeSocket.instances[0]!;
    socket.open();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    socket.receive({ type: "vault", unlocked: false });
    socket.receive({ type: "vault", unlocked: true });
    expect(onVaultChange.mock.calls).toEqual([[false], [true]]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["account"] });
  });
});
