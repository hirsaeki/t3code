import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const requests = vi.hoisted(() => vi.fn());

vi.mock(import("./presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  const presentationsAtom = Atom.make(
    new Map(
      ["local", "remote"].map((id) => [
        id,
        {
          entry: { target: { label: id } },
          connection: { phase: "connected" },
          serverConfig: { providers: [] },
        },
      ]),
    ),
  );
  return {
    environmentPresentations: {
      presentationsAtom,
      presentationsWithProvidersAtom: presentationsAtom,
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
    primaryServerKeybindingsAtom: Atom.make([]),
    serverEnvironment: {
      usageModelFilterAtom: Atom.family(() => Atom.make(undefined)),
      usageSummary: (input: unknown) => {
        requests(input);
        return Atom.make(AsyncResult.initial());
      },
    },
  } as never;
});

vi.mock(import("./primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { localEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null) } as never;
});
vi.mock(import("../hooks/useSettings"), () => ({ usePrimarySettings: () => false }) as never);
vi.mock(
  import("./use-atom-command"),
  () => ({ useAtomCommand: () => async () => undefined }) as never,
);
vi.mock(
  import("../components/AppRouteModal"),
  () =>
    ({
      AppRouteModal: ({ children }: { children: ReactNode }) => children,
      AppRouteModalClose: () => null,
    }) as never,
);
vi.mock(
  import("../components/usage/UsageLimits"),
  () => ({ UsageLimitsSection: () => null }) as never,
);
vi.mock(
  import("../components/usage/UsagePriceOverrides"),
  () => ({ UsagePriceOverrides: () => null }) as never,
);
vi.mock(
  import("../components/usage/UsageModelDialog"),
  () => ({ UsageModelDialog: () => null, SpeedPremium: () => null }) as never,
);
vi.mock(
  import("../components/settings/ChatGptUsageButton"),
  () => ({ ChatGptUsageButton: () => null }) as never,
);
vi.mock(
  import("../components/usage/usagePagePreferences"),
  () =>
    ({
      readUsagePagePreferences: () => ({ metric: "limits", windowDays: 30 }),
      saveUsagePagePreferences: () => undefined,
    }) as never,
);

import { UsagePage } from "../components/usage/UsagePage";
import { localEnvironmentIdAtom } from "./primaryEnvironment";
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

      requests.mockClear();
      await screen.rerender(ui([]));
      expect(requests).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  });

  it.each(["local", null])(
    "selects the current environment once available (%s) and retains explicit deselection",
    async (initial) => {
      requests.mockClear();
      const registry = AtomRegistry.make();
      if (!Atom.isWritable<EnvironmentId | null, EnvironmentId | null>(localEnvironmentIdAtom)) {
        throw new Error("Fixture environment atom must be writable");
      }
      registry.set(localEnvironmentIdAtom, initial === null ? null : EnvironmentId.make(initial));
      try {
        await using screen = await render(
          <RegistryContext.Provider value={registry}>
            <UsagePage />
          </RegistryContext.Provider>,
        );
        expect(requests.mock.calls.map(([request]) => request.environmentId)).toEqual(
          initial === null ? [] : [initial],
        );
        if (initial === null) {
          await expect
            .element(screen.getByText("Select an environment to see limits."))
            .toBeVisible();
          await act(() => registry.set(localEnvironmentIdAtom, EnvironmentId.make("local")));
        }
        await expect
          .element(screen.getByRole("button", { name: "local", exact: true }))
          .toBeVisible();
        expect(requests.mock.calls.map(([request]) => request.environmentId)).toEqual(["local"]);
        await screen.getByRole("button", { name: "local", exact: true }).click();
        await page.getByRole("menuitemcheckbox", { name: "local", exact: true }).click();
        await expect
          .element(screen.getByText("Select an environment to see limits."))
          .toBeVisible();
        requests.mockClear();
        await act(() => registry.set(localEnvironmentIdAtom, EnvironmentId.make("remote")));
        await expect
          .element(screen.getByText("Select an environment to see limits."))
          .toBeVisible();
        expect(requests).not.toHaveBeenCalled();
      } finally {
        registry.dispose();
      }
    },
  );

  it.each(["none", "all"])(
    "preserves an explicit %s selection while the current environment resolves",
    async (selection) => {
      requests.mockClear();
      const registry = AtomRegistry.make();
      if (!Atom.isWritable<EnvironmentId | null, EnvironmentId | null>(localEnvironmentIdAtom)) {
        throw new Error("Fixture environment atom must be writable");
      }
      registry.set(localEnvironmentIdAtom, null);
      try {
        await using screen = await render(
          <RegistryContext.Provider value={registry}>
            <UsagePage />
          </RegistryContext.Provider>,
        );
        expect(requests).not.toHaveBeenCalled();
        await screen.getByRole("button", { name: "0 environments", exact: true }).click();
        const all = page.getByRole("menuitemcheckbox", { name: "All environments", exact: true });
        await all.click();
        await expect.element(all).toHaveAttribute("aria-checked", "true");
        expect(requests.mock.calls.map(([request]) => request.environmentId)).toEqual([
          "local",
          "remote",
        ]);
        if (selection === "none") {
          await all.click();
          await expect.element(all).toHaveAttribute("aria-checked", "false");
          await expect
            .element(screen.getByText("Select an environment to see limits."))
            .toBeVisible();
          requests.mockClear();
        }
        await userEvent.keyboard("{Escape}");
        await act(() => registry.set(localEnvironmentIdAtom, EnvironmentId.make("local")));
        const trigger = screen.getByRole("button", {
          name: selection === "all" ? "All environments" : "0 environments",
          exact: true,
        });
        await expect.element(trigger).toBeVisible();
        expect(requests.mock.calls.map(([request]) => request.environmentId)).toEqual(
          selection === "all" ? ["local", "remote"] : [],
        );
        await trigger.click();
        for (const name of ["All environments", "local", "remote"]) {
          await expect
            .element(page.getByRole("menuitemcheckbox", { name, exact: true }))
            .toHaveAttribute("aria-checked", selection === "all" ? "true" : "false");
        }
      } finally {
        registry.dispose();
      }
    },
  );
});
