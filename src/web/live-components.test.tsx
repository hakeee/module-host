// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { component, defineContract } from "../contract.js";
import { ModuleCompositionError } from "../resolve.js";
import {
  LiveConnection,
  ModuleHostProvider,
  RouterOutlet,
  createWebHost,
  memoryHistory,
  useLiveStatus,
  webModule,
  type AnyWebModule,
  type WebHost,
} from "./index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- a controllable fake WebSocket ------------------------------------------

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    act(() => this.onopen?.());
  }
  receive(message: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
  drop(code = 1006) {
    act(() => this.onclose?.({ code }));
  }
  close() {
    this.closed = true;
  }
}

// --- contracts and modules -----------------------------------------------------

const peopleContract = defineContract({
  id: "people",
  version: 1,
  queries: {
    list: { input: z.object({}), output: z.array(z.string()) },
    get: { input: z.object({ id: z.number() }), output: z.string() },
  },
  events: {
    renamed: { payload: z.object({ id: z.number(), name: z.string() }), live: true, invalidates: ["list"] },
    internal: z.object({ id: z.number() }),
  },
  components: {
    PersonChip: component<{ name: string }>(),
    Broken: component(),
  },
});

const peopleWeb = webModule({ contract: peopleContract }).define({
  components: {
    PersonChip: ({ name }) => <span className="chip">{name}</span>,
    Broken: () => {
      throw new Error("component crashed");
    },
  },
});

const pagesContract = defineContract({ id: "pages", version: 1, pages: { home: { path: "/", params: z.object({}) } } });
const pagesMod = webModule({ contract: pagesContract, requires: [peopleWeb] });

const seenEvents: unknown[] = [];
function Home() {
  const Chip = pagesMod.useComponent(peopleContract.components.PersonChip);
  const Broken = pagesMod.useComponent(peopleContract.components.Broken);
  pagesMod.useLiveEvent(peopleContract, "renamed", (payload) => {
    const name: string = payload.name; // typed from the contract
    seenEvents.push({ ...payload, name });
  });
  return (
    <main>
      <Chip name="Erik" />
      <pagesMod.Component of={peopleContract.components.PersonChip} name="Anna" />
      <Broken />
      <p>after broken</p>
      <Status />
    </main>
  );
}
function Status() {
  return <i data-testid="status">{useLiveStatus()}</i>;
}
const pagesWeb = pagesMod.define({ pages: { home: Home } });

// --- harness -------------------------------------------------------------------

let container: HTMLElement;
afterEach(() => {
  container?.remove();
  FakeSocket.instances = [];
  seenEvents.length = 0;
});

function mount(host: WebHost, queryClient = new QueryClient()) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ModuleHostProvider host={host}>
          <LiveConnection />
          <RouterOutlet />
        </ModuleHostProvider>
      </QueryClientProvider>,
    ),
  );
  return { root, queryClient };
}

const makeHost = (modules: readonly AnyWebModule[] = [pagesWeb]) =>
  createWebHost({ modules, baseUrl: "https://api.test/m", history: memoryHistory("/"), WebSocket: FakeSocket as never });

describe("shared components", () => {
  it("renders another module's component through the contract, isolating crashes", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(makeHost());
    expect([...container.querySelectorAll(".chip")].map((e) => e.textContent)).toEqual(["Erik", "Anna"]);
    expect(container.textContent).toContain("after broken");
    error.mockRestore();
  });

  it("renders nothing when no installed web module implements the component", () => {
    const uiOnly = webModule({ contract: pagesContract, requires: [peopleContract] });
    const Page = () => {
      const Chip = uiOnly.useComponent(peopleContract.components.PersonChip);
      return (
        <p>
          [<Chip name="x" />]
        </p>
      );
    };
    mount(makeHost([uiOnly.define({ pages: { home: Page } })]));
    expect(container.textContent).toContain("[]");
  });

  it("requires implementations and type-checks props and visibility", () => {
    // @ts-expect-error - every contract component needs an implementation
    webModule({ contract: peopleContract }).define({ components: { PersonChip: () => null } });
    const loner = webModule({ id: "loner" });
    // @ts-expect-error - loner didn't require people
    expect(() => loner.useComponent(peopleContract.components.PersonChip)).toThrow(ModuleCompositionError);
    // Type-only (never called): the returned component carries the contract's props.
    const typeOnly = () => {
      const Chip = pagesMod.useComponent(peopleContract.components.PersonChip);
      // @ts-expect-error - PersonChip needs a string `name`
      void (<pagesMod.Component of={peopleContract.components.PersonChip} name={3} />);
      // @ts-expect-error - PersonChip needs a string `name`
      return <Chip name={3} />;
    };
    void typeOnly;
  });
});

describe("live updates", () => {
  it("connects to baseUrl/_live, invalidates declared queries and runs useLiveEvent handlers", async () => {
    const { queryClient } = mount(makeHost());
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("wss://api.test/m/_live");
    socket.open();
    expect(container.querySelector("[data-testid=status]")?.textContent).toBe("open");

    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    socket.receive({ type: "event", contract: "people", event: "renamed", payload: { id: 3, name: "Erik A" } });
    await vi.waitFor(() => expect(seenEvents).toEqual([{ id: 3, name: "Erik A" }]));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["people", "list"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["people", "get"] });
  });

  it("ignores non-live, unknown and malformed events", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(makeHost());
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "event", contract: "people", event: "internal", payload: { id: 1 } });
    socket.receive({ type: "event", contract: "nobody", event: "x", payload: {} });
    socket.receive({ type: "event", contract: "people", event: "renamed", payload: { id: "bad" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(seenEvents).toEqual([]);
    error.mockRestore();
  });

  it("reconnects with backoff and refetches live contracts after a reconnect", async () => {
    vi.useFakeTimers();
    const { queryClient } = mount(makeHost());
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.drop();
    expect(container.querySelector("[data-testid=status]")?.textContent).toBe("closed");

    act(() => vi.advanceTimersByTime(1000));
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.open();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["people"] });
    vi.useRealTimers();
  });

  it("closes the socket when <LiveConnection> unmounts", () => {
    const { root } = mount(makeHost());
    FakeSocket.instances[0]!.open();
    act(() => root.unmount());
    expect(FakeSocket.instances[0]!.closed).toBe(true);
  });
});
