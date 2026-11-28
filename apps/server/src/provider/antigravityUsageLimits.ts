import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

// ACP does not expose account quotas. Native sign-in and inference remain owned by agy.
export const antigravityUsageLimits = Effect.map(DateTime.now, (now) =>
  makeUnavailableUsageLimits({
    checkedAt: DateTime.formatIso(now),
    reason: "unsupported",
    message: "Antigravity account limits are unavailable through its native ACP interface.",
  }),
);
