import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import "~/index.css";

const base: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  config: { home: "/private/agent-home" },
};

function card(
  instance: ProviderInstanceConfig,
  onUpdate: (next: ProviderInstanceConfig) => Promise<boolean>,
) {
  return (
    <ProviderInstanceCard
      instanceId={ProviderInstanceId.make("personal")}
      instance={instance}
      driverOption={undefined}
      liveProvider={undefined}
      mode="editor"
      onUpdate={onUpdate}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />
  );
}

describe("provider usage permissions", () => {
  it("starts both permissions off and changes them independently", async () => {
    const update = vi.fn(async () => true);
    await using screen = await render(card(base, update));
    const history = screen.getByRole("switch", { name: "External usage history" });
    const account = screen.getByRole("switch", { name: "Account-wide usage" });
    await expect.element(history).not.toBeChecked();
    await expect.element(account).not.toBeChecked();

    await userEvent.click(history);
    expect(update).toHaveBeenLastCalledWith({ ...base, usageHistoryEnabled: true });

    await screen.rerender(card({ ...base, usageHistoryEnabled: true }, update));
    await expect.element(account).not.toBeChecked();
    await userEvent.click(account);
    expect(update).toHaveBeenLastCalledWith({
      ...base,
      usageHistoryEnabled: true,
      accountUsageEnabled: true,
    });
  });

  it("allows consent to be revoked while the provider is disabled", async () => {
    const update = vi.fn(async () => true);
    const disabled = { ...base, enabled: false, usageHistoryEnabled: true };
    await using screen = await render(card(disabled, update));
    const history = screen.getByRole("switch", { name: "External usage history" });
    await expect.element(history).toBeEnabled();
    await expect.element(screen.getByRole("switch", { name: "Account-wide usage" })).toBeDisabled();
    await userEvent.click(history);
    expect(update).toHaveBeenLastCalledWith({ ...disabled, usageHistoryEnabled: false });
  });
});
