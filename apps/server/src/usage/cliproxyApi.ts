import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

/** A hub with its management key already read from wherever the setting keeps it. */
export interface CliproxyHub {
  readonly url: UsageLimitSourceConfig["url"];
  readonly managementKey: string;
}

const AuthFile = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  id_token: Schema.optional(
    Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
  ),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
const AuthFileModels = Schema.Struct({
  models: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const decodeAuthFiles = Schema.decodeUnknownEffect(AuthFiles);
const decodeAuthFileModels = Schema.decodeUnknownEffect(AuthFileModels);

// Extra CAs can fix untrusted chains; expiry/hostname failures report codes only.
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// fetch wraps Node error codes in generic TypeErrors.
const nodeErrorCode = (cause: unknown) => {
  for (let error = cause, depth = 0; error instanceof Error && depth < 3; depth += 1) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = error.cause;
  }
  return undefined;
};

// Hub responses can contain credentials; expose only failure kind, HTTP status or Node code.
const describeManagementFailure = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "The hub did not answer within 15 seconds.";
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    if (reason._tag === "StatusCodeError") {
      return `The hub answered with HTTP ${reason.response.status}.`;
    }
    const code = reason._tag === "TransportError" ? nodeErrorCode(reason.cause) : undefined;
    if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
      return `The hub's TLS certificate is not trusted (${code}). If it comes from a private CA, add that CA to NODE_EXTRA_CA_CERTS.`;
    }
    if (code !== undefined) return `The hub request failed (${code}).`;
  }
  return "The hub management request failed.";
};

const HUB_PROVIDERS = new Map<string, ProviderDriverKind>([
  ["codex", ProviderDriverKind.make("codex")],
  ["claude", ProviderDriverKind.make("claudeAgent")],
  ["xai", ProviderDriverKind.make("grok")],
  ["antigravity", ProviderDriverKind.make("antigravity")],
]);

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const management = Effect.fn("CliproxyApi.management")(function* (
    hub: CliproxyHub,
    path: string,
  ) {
    const url = yield* Effect.try({
      try: () => {
        const base = new URL(hub.url);
        base.pathname = base.pathname.replace(/(\/management\.html)?\/?$/i, "/");
        return new URL(`v0/management/${path}`, base).toString();
      },
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${hub.managementKey}`,
        "User-Agent": "t3-code",
      }),
    );
    return yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("15 seconds"),
      Effect.mapError(
        (error) => new UsageLimitSourceError({ detail: describeManagementFailure(error) }),
      ),
    );
  });

  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    hub: CliproxyHub,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const response = yield* management(hub, "auth-files");
    const accounts = yield* decodeAuthFiles(response).pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "The hub could not list accounts." })),
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const readable = accounts.files.flatMap((account) => {
      const driver = HUB_PROVIDERS.get(account.provider);
      return driver && !account.disabled ? [{ account, driver }] : [];
    });
    return yield* Effect.forEach(readable, ({ account, driver }) =>
      Effect.gen(function* () {
        const models = yield* management(
          hub,
          `auth-files/models?name=${encodeURIComponent(account.id)}`,
        ).pipe(
          Effect.flatMap(decodeAuthFileModels),
          Effect.map(({ models }) => models.flatMap(({ id }) => id.trim() ? [id.trim()] : [])),
          Effect.timeoutOption("2 seconds"),
          Effect.orElseSucceed(() => Option.none()),
        );
        // Inventory is a documented hub API. Upstream quota/reset calls are not delegated to the hub.
        return {
          id: account.id,
          driver,
          ...(account.email ? { email: account.email } : {}),
          ...(account.id_token?.chatgpt_account_id?.trim()
            ? { workspaceId: account.id_token.chatgpt_account_id.trim() }
            : {}),
          ...(Option.isSome(models) ? { models: models.value } : {}),
          usageLimits: makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message: "Account quotas and reset credits are unavailable through this hub integration.",
          }),
        };
      }),
      { concurrency: "unbounded" },
    );
  });
  return { readAccounts };
});
