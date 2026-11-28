import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";

const config = {
  url: "http://hub.test:8317",
  managementKey: "management-secret",
};
const accounts = [
  {
    id: "codex.json",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  { id: "claude.json", provider: "claude" },
  { id: "grok.json", provider: "xai" },
  { id: "antigravity.json", provider: "antigravity" },
  { id: "disabled.json", provider: "codex", disabled: true },
  { id: "unknown.json", provider: "unknown" },
];

function fixture(options: { models?: (name: string) => Response } = {}) {
  const requests: Array<{ path: string; name: string | null }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      expect(request.headers["user-agent"]).toBe("t3-code");
      expect(request.headers.originator).toBeUndefined();
      expect(request.headers["anthropic-beta"]).toBeUndefined();
      expect(request.headers["x-xai-token-auth"]).toBeUndefined();
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      const path = url.pathname;
      const name = url.searchParams.get("name");
      requests.push({ path, name });
      if (path.endsWith("/auth-files/models")) {
        return HttpClientResponse.fromWeb(
          request,
          options.models?.(name!) ?? Response.json({}, { status: 404 }),
        );
      }
      expect(path).toMatch(/\/auth-files$/);
      return HttpClientResponse.fromWeb(request, Response.json({ files: accounts }));
    }),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(Effect.provideService(HttpClient.HttpClient, http)),
  };
}

const unreachableHub = (
  fail: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => HttpClientError.HttpClientError,
) =>
  makeCliproxyApi.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.fail(fail(request))),
    ),
  );

describe("CLIProxyAPI hub failures", () => {
  it.effect("names the TLS code when the hub's certificate is not trusted", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              // Node's fetch wraps the TLS error, which carries the code, in a generic TypeError.
              cause: new TypeError("fetch failed", {
                cause: Object.assign(new Error("unable to get local issuer certificate"), {
                  code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                }),
              }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
      expect(error.detail).toContain("NODE_EXTRA_CA_CERTS");
    }),
  );

  // regression: #18168 Limits hub failures name their TLS, HTTP, or timeout cause
  it.effect("ignores a transport code that is not a short Node error code", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("odd"), { code: "X".repeat(200) }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toBe("The hub management request failed.");
    }),
  );

  it.effect("names the status, not the body, when the hub rejects the request", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "management-secret is wrong" }, { status: 401 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(Effect.provideService(HttpClient.HttpClient, test));
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("401");
      expect(error.detail).not.toContain("management-secret");
    }),
  );
});

describe("CLIProxyAPI inventory", () => {
  it.effect(
    "lists active supported accounts without forwarding upstream quota or reset calls",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        const result = yield* (yield* test.api).readAccounts(config);
        expect(result.map(({ driver }) => driver)).toEqual([
          "codex",
          "claudeAgent",
          "grok",
          "antigravity",
        ]);
        expect(result[0]).toMatchObject({ email: "first@example.com", workspaceId: "account-a" });
        for (const account of result) {
          expect(account.usageLimits.windows).toEqual([]);
          expect(account.usageLimits.unavailable?.reason).toBe("unsupported");
          expect(account.usageLimits.resetCredits).toBeUndefined();
        }
        expect(test.requests).toHaveLength(5);
        expect(test.requests.flatMap(({ name }) => (name ? [name] : []))).toEqual(
          accounts.slice(0, 4).map(({ id }) => id),
        );
      }),
  );

  it.effect("retains documented model inventory when available", () =>
    Effect.gen(function* () {
      const test = fixture({
        models: (name) => Response.json({ models: [{ id: ` ${name}-model ` }, { id: " " }] }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(result.map(({ id, models }) => ({ id, models }))).toEqual(
        accounts.slice(0, 4).map(({ id }) => ({ id, models: [`${id}-model`] })),
      );
    }),
  );

  it.effect.each([
    "https://tools.test/cliproxy",
    "https://tools.test/cliproxy/",
    "https://tools.test/cliproxy/management.html",
    "https://tools.test/cliproxy/management.html/",
    "https://tools.test/cliproxy/MANAGEMENT.HTML",
    "https://tools.test/cliproxy/management.html?tab=accounts",
    "https://tools.test/cliproxy/management.html#accounts",
    "https://tools.test/cliproxy/management.html/?tab=accounts",
    "https://tools.test/cliproxy/management.html/#accounts",
  ])("keeps the path of a hub served under a prefix: %s", (url) =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) => request.path.startsWith("/cliproxy/v0/management/")),
      ).toBe(true);
    }),
  );

  it.effect("preserves a hub path that only ends with the panel filename", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url: "https://tools.test/team-management.html" });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) =>
          request.path.startsWith("/team-management.html/v0/management/"),
        ),
      ).toBe(true);
    }),
  );
});
