import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const requests = vi.hoisted(() => vi.fn());

vi.mock(import("./presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(
        new Map(
          ["local", "remote"].map((id) => [
            id,
            { entry: { target: { label: id } }, connection: { phase: "connected" } },
          ]),
        ),
      ),
    },
  } as never;
});

vi.mock(import("./session"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: Atom.family(() => Atom.make(AsyncResult.success(null))),
    },
    readEnvironmentScope: () => true,
  } as never;
});

vi.mock(import("@t3tools/client-runtime/state/usage-access"), () => ({
  resolveUsageAccess: () => ({ canReadDiagnostics: true, isPending: false, error: null }),
}));

vi.mock(import("./server"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      usageModelFilterAtom: Atom.family(() => Atom.make(undefined)),
      usageSummary: (input: unknown) => {
        requests(input);
        return Atom.make(AsyncResult.initial());
      },
    },
  } as never;
});

import { useUsage } from "./usage";

const input: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-11-01"),
  untilDay: UsageDay.make("2026-11-25"),
  timeZone: "Asia/Tokyo",
};

describe("usage environment selection", () => {
  it("does not start usage requests for environments outside the current selection", async () => {
    requests.mockClear();
    const registry = AtomRegistry.make();
    function Reader({ selected }: { readonly selected: ReadonlySet<EnvironmentId> }) {
      const usage = useUsage(input, selected);
      return <span>{usage.selectedEnvironments.length} selected</span>;
    }
    const ui = (ids: readonly string[]) => (
      <RegistryContext.Provider value={registry}>
        <Reader selected={new Set(ids.map((id) => EnvironmentId.make(id)))} />
      </RegistryContext.Provider>
    );
    try {
      // This hook reads atoms only; it has no navigation or router dependencies.
      await using screen = await render(ui([]), { router: false });
      expect(requests).not.toHaveBeenCalled();

      await screen.rerender(ui(["local"]));
      expect(requests.mock.calls.map(([request]) => request.environmentId)).toEqual(["local"]);
      expect(requests.mock.calls[0]?.[0].input).not.toHaveProperty("selectedEnvironmentIds");

      await screen.rerender(ui(["remote"]));
      expect(requests.mock.calls.map(([request]) => request.environmentId)).toEqual([
        "local",
        "remote",
      ]);
    } finally {
      registry.dispose();
    }
  });
});
