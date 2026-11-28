import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CURSOR_ACCOUNT_CACHE_FILE_NAME, CURSOR_ACCOUNT_TTL_MS } from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

it.effect("purges an intermediate revocation and discards the refresh started before it", () =>
  Effect.gen(function* () {
    const nowMs = Date.parse("2026-11-01T12:00:00Z");
    yield* TestClock.setTime(nowMs);
    const instanceId = ProviderInstanceId.make("cursor-selected");
    const selected: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      usageHistoryRetentionDays: "unlimited",
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("cursor"),
          enabled: true,
          accountUsageEnabled: true,
          environment: [{ name: "CURSOR_API_KEY", value: "synthetic-api-key", sensitive: true }],
        },
      },
    };
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
      const deliver = yield* Deferred.make<void>();
      const updates = yield* Queue.unbounded<{
        readonly settings: ServerSettings;
        readonly applied: Deferred.Deferred<void>;
      }>();
      const changes = Stream.fromQueue(updates).pipe(
        Stream.flatMap(({ settings, applied }) =>
          Stream.fromEffect(Deferred.await(deliver).pipe(Effect.as(settings))).pipe(
            Stream.concat(Stream.fromEffectDrain(Deferred.succeed(applied, undefined))),
          ),
        ),
      );
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      let reads = 0;
      const context = yield* Layer.build(
        CursorUsageAccounts.layer.pipe(
          Layer.provide(
            Layer.succeed(ProviderHost.ProviderHost, {
              ...host,
              settings: { ...host.settings, changes, subscribe: Effect.succeed(changes) },
            }),
          ),
          Layer.provide(
            Layer.succeed(CursorAccountReader.CursorAccountReader, {
              read: Effect.fn("CursorUsageAccounts.test.read")(function* () {
                const request = ++reads;
                if (request === 2) {
                  yield* Deferred.succeed(refreshStarted, undefined);
                  yield* Deferred.await(releaseRefresh);
                }
                const record: UsageRecord = {
                  provider: "cursor",
                  timestampMs: nowMs - 1_000,
                  model: "synthetic-model",
                  sessionId: `fetch-${request}`,
                  totals: { ...EMPTY_TOTALS, outputTokens: request },
                  reportedCostUsd: null,
                  speed: "standard",
                  dedupeKey: `fetch-${request}`,
                };
                return {
                  accountKey: "synthetic-account",
                  records: [record],
                  missing: false,
                  error: null,
                };
              }),
            }),
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(deliver, undefined).pipe(
          Effect.andThen(Deferred.succeed(releaseRefresh, undefined)),
        ),
      );
      const accounts = Context.get(context, CursorUsageAccounts.CursorUsageAccounts);
      const input = {
        instances: [{ instanceId, environment: { CURSOR_API_KEY: "synthetic-api-key" } }],
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      };
      const cachePath = path.join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
      yield* accounts.scan(input);
      yield* accounts.awaitPersisted;
      assert.isTrue(yield* fs.exists(cachePath));
      assert.strictEqual(reads, 1);

      yield* TestClock.adjust(CURSOR_ACCOUNT_TTL_MS + 1);
      const pending = yield* accounts.scan(input).pipe(Effect.forkChild);
      yield* Deferred.await(refreshStarted);
      const revoked: ServerSettings = {
        ...selected,
        providerInstances: {
          [instanceId]: { ...selected.providerInstances[instanceId]!, accountUsageEnabled: false },
        },
      };
      const revokedApplied = yield* Deferred.make<void>();
      const selectedApplied = yield* Deferred.make<void>();
      yield* hostSettings.set(revoked);
      yield* Queue.offer(updates, { settings: revoked, applied: revokedApplied });
      yield* hostSettings.set(selected);
      yield* Queue.offer(updates, { settings: selected, applied: selectedApplied });
      yield* Deferred.succeed(deliver, undefined);
      yield* Deferred.await(selectedApplied);
      yield* accounts.awaitPersisted;
      const retainedAfterRevocation = yield* fs.exists(cachePath);

      yield* Deferred.succeed(releaseRefresh, undefined);
      const stale = yield* Fiber.join(pending);
      yield* accounts.awaitPersisted;
      const retainedAfterRefresh = yield* fs.exists(cachePath);
      const sources = yield* accounts.scan(input);

      assert.isFalse(retainedAfterRevocation);
      assert.deepStrictEqual(stale, []);
      assert.isFalse(retainedAfterRefresh);
      assert.strictEqual(reads, 3);
      assert.deepStrictEqual(
        sources.flatMap((source) =>
          (source.files ?? []).flatMap((file) => file.records.map((record) => record.sessionId)),
        ),
        ["fetch-3"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestProviderHost.layer({ settings: selected })));
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Effect.provideService(HostProcess.Environment, {}),
  ),
);
