// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, slot } from "../contract.js";
import { Link, ModuleHostProvider, RouterOutlet, contribute, createWebHost, memoryHistory, webModule, Slot, type PageProps } from "./index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const contract = defineContract({
  id: "people",
  version: 1,
  pages: {
    list: { path: "/people", params: z.object({}) },
    detail: { path: "/people/:id", params: z.object({ id: z.coerce.number() }) },
  },
  slots: { sections: slot<{ personId: number }>() },
});

const mod = webModule({ contract });
const people = mod.define({
  pages: {
    list: () => (
      <Link to={contract.pages.detail} params={{ id: 5 }}>
        go
      </Link>
    ),
    detail: ({ params }: PageProps<typeof contract.pages.detail>) => (
      <main>
        <h1>person {params.id}</h1>
        <Slot slot={contract.slots.sections} props={{ personId: params.id }} />
      </main>
    ),
  },
});

const extras = webModule({ id: "extras", requires: [people] }).define({
  contributions: [
    contribute(contract.slots.sections, () => {
      throw new Error("contribution crashed");
    }),
    contribute(contract.slots.sections, ({ personId }) => <p>still here {personId}</p>, { order: 200 }),
  ],
});

let container: HTMLElement;
afterEach(() => container?.remove());

function mount(path: string) {
  const history = memoryHistory(path);
  const host = createWebHost({ modules: [extras], baseUrl: "/m", history });
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ModuleHostProvider host={host}>
          <RouterOutlet />
        </ModuleHostProvider>
      </QueryClientProvider>,
    ),
  );
  return history;
}

describe("in a real DOM", () => {
  it("keeps the page alive when one contribution crashes", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mount("/people/5");
    expect(container.textContent).toContain("person 5");
    expect(container.textContent).toContain("still here 5");
    error.mockRestore();
  });

  it("navigates client-side on link clicks", () => {
    const history = mount("/people");
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/people/5");
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(history.entries).toEqual(["/people", "/people/5"]);
    expect(container.textContent).toContain("person 5");
  });
});
