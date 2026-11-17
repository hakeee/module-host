import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, slot } from "../contract.js";
import { ModuleCompositionError } from "../resolve.js";
import {
  EntityLink,
  Link,
  ModuleHostProvider,
  ModuleRpcError,
  RouterOutlet,
  Slot,
  contribute,
  createWebHost,
  memoryHistory,
  useNav,
  webModule,
  type ContractHooks,
  type PageProps,
  type WebHost,
} from "./index.js";

const peopleContract = defineContract({
  id: "people",
  version: 1,
  queries: {
    get: { input: z.object({ id: z.number() }), output: z.object({ id: z.number(), name: z.string() }) },
    labels: {
      input: z.object({ ids: z.array(z.number()) }),
      output: z.array(z.object({ id: z.number(), label: z.string().nullable() })),
    },
  },
  commands: { rename: { input: z.object({ id: z.number(), name: z.string() }), output: z.object({ ok: z.boolean() }) } },
  pages: {
    list: { path: "/people", params: z.object({}) },
    detail: { path: "/people/:id", params: z.object({ id: z.coerce.number() }) },
  },
  slots: { "detail.sections": slot<{ personId: number }>() },
  entities: { person: { page: "detail", labels: "labels" } },
});

const journalContract = defineContract({
  id: "journal",
  version: 1,
  pages: { timeline: { path: "/timeline", params: z.object({}) } },
});

// --- people: data + pages ---------------------------------------------------------

const peopleMod = webModule({ contract: peopleContract });
let capturedHooks: ContractHooks<typeof peopleContract> | undefined;

function PeopleList() {
  capturedHooks = peopleMod.useModule(peopleContract);
  return <p>people list</p>;
}
function PersonPage({ params }: PageProps<typeof peopleContract.pages.detail>) {
  const id: number = params.id; // typed as number, parsed from the URL string
  return (
    <section>
      <h1>person {id}</h1>
      <Slot slot={peopleContract.slots["detail.sections"]} props={{ personId: id }} />
    </section>
  );
}
const peopleWeb = peopleMod.define({
  pages: { list: PeopleList, detail: PersonPage },
  nav: [{ label: "People", to: peopleContract.pages.list, activeOn: [peopleContract.pages.detail], order: 20 }],
});

// --- journal: requires people, adds UI to people's page --------------------------

const journalMod = webModule({ contract: journalContract, requires: [peopleWeb] });

function MoodSection({ personId }: { personId: number }) {
  return <div>mood for {personId}</div>;
}
function Timeline() {
  return (
    <p>
      timeline <EntityLink entity={peopleContract.entities.person} id={3} />
      <Link to={peopleContract.pages.detail} params={{ id: 3 }}>
        erik
      </Link>
    </p>
  );
}
const journalWeb = journalMod.define({
  pages: { timeline: Timeline },
  nav: [{ label: "Timeline", to: journalContract.pages.timeline, order: 10 }],
  contributions: [
    contribute(peopleContract.slots["detail.sections"], MoodSection, { order: 2 }),
    contribute(peopleContract.slots["detail.sections"], ({ personId }) => <div>first for {personId}</div>, { order: 0 }),
  ],
});

// --- helpers --------------------------------------------------------------------------

function render(host: WebHost) {
  const queryClient = new QueryClient();
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <ModuleHostProvider host={host}>
        <Nav />
        <RouterOutlet notFound={<p>not found</p>} />
      </ModuleHostProvider>
    </QueryClientProvider>,
  );
}

function Nav() {
  return (
    <nav>
      {useNav().map((item) => (
        <a key={item.href} href={item.href} data-active={item.active}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}

describe("composition", () => {
  it("pulls in required web modules and orders nav", () => {
    const host = createWebHost({ modules: [journalWeb], baseUrl: "/m", history: memoryHistory("/timeline") });
    expect(host.modules.map((m) => m.id)).toEqual(["people", "journal"]);
    expect(host.nav.map((n) => n.label)).toEqual(["Timeline", "People"]);
  });

  it("refuses contributions and nav into contracts a module didn't require", () => {
    const sneaky = webModule({ id: "sneaky" }).define({
      contributions: [contribute(peopleContract.slots["detail.sections"], MoodSection)],
    });
    expect(() => createWebHost({ modules: [sneaky, peopleWeb], baseUrl: "/m", history: memoryHistory() })).toThrow(
      /contributes to a slot of "people" without requiring it/,
    );
  });

  it("lets a UI-only module sit on a contract with no web implementation", () => {
    const uiOnly = webModule({ id: "people-widgets", requires: [peopleContract] }).define({
      contributions: [contribute(peopleContract.slots["detail.sections"], MoodSection)],
    });
    expect(() => createWebHost({ modules: [uiOnly], baseUrl: "/m", history: memoryHistory() })).not.toThrow();
  });

  it("refuses nav to a page nobody renders, and clashing paths", () => {
    const uiOnly = webModule({ id: "ui-only", requires: [peopleContract] }).define({
      nav: [{ label: "x", to: peopleContract.pages.list }],
    });
    expect(() => createWebHost({ modules: [uiOnly], baseUrl: "/m", history: memoryHistory() })).toThrow(/which no installed module renders/);

    const clash = webModule({ contract: defineContract({ id: "clash", version: 1, pages: { p: { path: "/people", params: z.object({}) } } }) }).define({
      pages: { p: () => null },
    });
    expect(() => createWebHost({ modules: [peopleWeb, clash], baseUrl: "/m", history: memoryHistory() })).toThrow(/share the path/);
  });

  it("type-checks pages, params and hook access", () => {
    // @ts-expect-error - every page in the contract needs a component
    peopleMod.define({ pages: { list: PeopleList } });
    // @ts-expect-error - journal didn't require this contract
    expect(() => journalMod.useModule(defineContract({ id: "other", version: 1 }))).toThrow(ModuleCompositionError);
    // @ts-expect-error - detail needs an id param
    void (<Link to={peopleContract.pages.detail}>x</Link>);
    // @ts-expect-error - slot props must match { personId: number }
    contribute(peopleContract.slots["detail.sections"], ({ name }: { name: string }) => <p>{name}</p>);
  });
});

describe("rendering", () => {
  it("routes to a page with parsed params, and renders slot contributions in order", () => {
    const html = render(createWebHost({ modules: [journalWeb], baseUrl: "/m", history: memoryHistory("/people/7") }));
    expect(html).toContain("person <!-- -->7");
    const first = html.indexOf("first for");
    const mood = html.indexOf("mood for");
    expect(first).toBeGreaterThan(-1);
    expect(mood).toBeGreaterThan(first);
    expect(html).toMatch(/href="\/people" data-active="true"/); // activeOn: detail
    expect(html).toMatch(/href="\/timeline" data-active="false"/);
  });

  it("renders links and entity links with real hrefs", () => {
    const html = render(createWebHost({ modules: [journalWeb], baseUrl: "/m", history: memoryHistory("/timeline") }));
    expect(html).toContain('href="/people/3"');
    expect(html).toMatch(/href="\/timeline" data-active="true"/);
  });

  it("renders notFound for unknown paths and invalid params", () => {
    const host = createWebHost({ modules: [journalWeb], baseUrl: "/m", history: memoryHistory("/nope") });
    expect(render(host)).toContain("not found");
    const badParam = createWebHost({ modules: [journalWeb], baseUrl: "/m", history: memoryHistory("/people/abc") });
    expect(render(badParam)).toContain("not found");
  });
});

describe("data hooks", () => {
  it("calls the server's rpc endpoint with validated input and output", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/people/rpc/get")) {
        expect(JSON.parse(init.body as string)).toEqual({ id: 7 });
        return new Response(JSON.stringify({ id: 7, name: "Erik", extra: true }));
      }
      return new Response(JSON.stringify({ error: "vault locked" }), { status: 423 });
    });
    const host = createWebHost({ modules: [peopleWeb], baseUrl: "https://api.test/m", history: memoryHistory("/people"), fetch: fetch as never });
    render(host);

    expect(await capturedHooks!.queries.get.fetch({ id: 7 })).toEqual({ id: 7, name: "Erik" });
    expect(fetch.mock.calls[0]![0]).toBe("https://api.test/m/people/rpc/get");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", credentials: "include" });

    await expect(capturedHooks!.commands.rename.call({ id: 7, name: "E" })).rejects.toMatchObject({ status: 423 });
    await expect(capturedHooks!.commands.rename.call({ id: 7, name: "E" })).rejects.toBeInstanceOf(ModuleRpcError);
    // @ts-expect-error - input is checked against the contract
    await expect(capturedHooks!.queries.get.fetch({ id: "7" })).rejects.toThrow(/people\.get input/);
    expect(capturedHooks!.queries.get.key({ id: 7 })).toEqual(["people", "get", { id: 7 }]);
  });
});
