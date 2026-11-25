import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, runPromise, test, WEB } from "./t3.ts";

const decodeSettings = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      providerInstances: Schema.Struct({
        devReplay: Schema.Struct({
          usageHistoryEnabled: Schema.optional(Schema.Boolean),
          accountUsageEnabled: Schema.optional(Schema.Boolean),
        }),
      }),
    }),
  ),
);

test(
  "External history and account usage consent stay independent after saving and revoking",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("usage-consent");
    const settingsPath = `${T3_HOME}/userdata/settings.json`;
    const readSettings = Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFileString(settingsPath),
    );
    const original = await runPromise(readSettings);
    const savedConsent = readSettings.pipe(
      Effect.flatMap(decodeSettings),
      Effect.map(({ providerInstances: { devReplay } }) => ({
        history: devReplay.usageHistoryEnabled === true,
        account: devReplay.accountUsageEnabled === true,
      })),
    );
    const environment = await runPromise(environmentId(app.baseUrl ?? ""));
    const route = `/settings/providers?instanceId=devReplay&machine=${encodeURIComponent(environment)}`;
    const history = screen.getByRole("switch", "External usage history", { exact: true });
    const account = screen.getByRole("switch", "Account-wide usage", { exact: true });

    try {
      await t3.open(route);
      await expect(history).toHaveAttribute("aria-checked", "false");
      await expect(account).toHaveAttribute("aria-checked", "false");
      await app.screenshot("usage-consent-defaults");

      await history.tap();
      await expect(history).toHaveAttribute("aria-checked", "true");
      await expect(account).toHaveAttribute("aria-checked", "false");
      expect(await runPromise(savedConsent)).toEqual({ history: true, account: false });
      await app.open(route);
      await expect(history).toHaveAttribute("aria-checked", "true");
      await expect(account).toHaveAttribute("aria-checked", "false");
      await app.screenshot("usage-history-only");

      await account.tap();
      await expect(account).toHaveAttribute("aria-checked", "true");
      await expect(history).toHaveAttribute("aria-checked", "true");
      await history.tap();
      await expect(history).toHaveAttribute("aria-checked", "false");
      await expect(account).toHaveAttribute("aria-checked", "true");
      expect(await runPromise(savedConsent)).toEqual({ history: false, account: true });
      await app.open(route);
      await expect(history).toHaveAttribute("aria-checked", "false");
      await expect(account).toHaveAttribute("aria-checked", "true");
      await app.screenshot("account-usage-only");

      await account.tap();
      await expect(account).toHaveAttribute("aria-checked", "false");
      await expect(history).toHaveAttribute("aria-checked", "false");
      expect(await runPromise(savedConsent)).toEqual({ history: false, account: false });
      await app.open(route);
      await expect(history).toHaveAttribute("aria-checked", "false");
      await expect(account).toHaveAttribute("aria-checked", "false");
      await app.screenshot("usage-consent-revoked");
    } finally {
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(settingsPath, original)),
      );
    }
  },
);
