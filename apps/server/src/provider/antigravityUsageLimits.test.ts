import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { antigravityUsageLimits } from "./antigravityUsageLimits.ts";

describe("Antigravity account limits", () => {
  it.effect("reports unavailable without filesystem, keyring or HTTP services", () =>
    Effect.gen(function* () {
      const limits = yield* antigravityUsageLimits;
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.credentialFingerprint).toBeUndefined();
    }),
  );
});
