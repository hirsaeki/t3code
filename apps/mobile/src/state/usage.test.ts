import { EnvironmentId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  requests: vi.fn(),
  refresh: vi.fn(
    async (_request: {
      readonly environmentIds: readonly EnvironmentId[];
      readonly input: UsageSummaryInput;
    }) => undefined,
  ),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: <A>(compute: () => A) => compute(),
  useCallback: <A>(callback: A) => callback,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: <A>(atom: Atom.Atom<A>) => fixture.registry!.get(atom),
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(
        new Map(
          ["one", "two"].map((id) => [
            id,
            { entry: { target: { label: id } }, connection: { phase: "connected" } },
          ]),
        ),
      ),
    },
  };
});
vi.mock("./session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: Atom.family(() => Atom.make(AsyncResult.success(null))),
    },
    readEnvironmentScope: () => true,
  };
});
vi.mock("@t3tools/client-runtime/state/usage-access", () => ({
  resolveUsageAccess: () => ({ canReadDiagnostics: true, isPending: false, error: null }),
}));
vi.mock("@t3tools/client-runtime/state/usage", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/usage")>()),
  refreshUsage: fixture.refresh,
}));
vi.mock("gt-react-native", async (original) => {
  const gt = await original<typeof import("gt-react-native")>();
  return { ...gt, useMessages: () => gt.mFallback };
});
vi.mock("./server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      usageModelFilterAtom: Atom.family(() => Atom.make(undefined)),
      usageSummary: (request: unknown) => {
        fixture.requests(request);
        return Atom.make(AsyncResult.initial());
      },
    },
  };
});

import { useUsage } from "./usage";

const input: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-11-01"),
  untilDay: UsageDay.make("2026-11-25"),
  timeZone: "Asia/Tokyo",
};

it("queries only selected mobile environments and excludes selection from refresh payloads", async () => {
  fixture.requests.mockClear();
  fixture.refresh.mockClear();
  const registry = AtomRegistry.make();
  fixture.registry = registry;
  const one = EnvironmentId.make("one");
  const two = EnvironmentId.make("two");
  try {
    const empty = useUsage(input, new Set());
    expect(empty.selectedEnvironments).toEqual([]);
    expect(empty.isPending).toBe(false);
    expect(fixture.requests).not.toHaveBeenCalled();

    const selected = useUsage(input, new Set([one]));
    expect(fixture.requests.mock.calls.map(([request]) => request.environmentId)).toEqual([one]);
    expect(fixture.requests.mock.calls[0]?.[0].input).not.toHaveProperty("selectedEnvironmentIds");
    await selected.refresh();
    expect(fixture.refresh).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentIds: [one], input }),
    );
    expect(fixture.refresh.mock.calls.at(-1)?.[0].input).not.toHaveProperty(
      "selectedEnvironmentIds",
    );

    useUsage(input, new Set([two]));
    expect(fixture.requests.mock.calls.map(([request]) => request.environmentId)).toEqual([
      one,
      two,
    ]);
    fixture.requests.mockClear();
    const deselected = useUsage(input, new Set());
    await deselected.refresh();
    expect(fixture.requests).not.toHaveBeenCalled();
    expect(fixture.refresh).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentIds: [], input }),
    );
  } finally {
    registry.dispose();
    fixture.registry = undefined;
  }
});
