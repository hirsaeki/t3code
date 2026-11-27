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
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AntigravityUsage from "./AntigravityUsage.ts";

const setup = Effect.fn("AntigravityUsage.test.setup")(function* (
  stage: "roots" | "history",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-usage-" });
  const root = yield* fs.realPath(dir);
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
    // Step usage: numeric model 1319 and ten input tokens.
    yield* sql.unsafe("INSERT INTO steps VALUES (?, ?)", [
      0,
      new Uint8Array([74, 5, 8, 167, 10, 16, 10]),
    ]);
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: path.join(root, "history.db") })),
    Effect.scoped,
  );

  const instanceId = ProviderInstanceId.make("antigravity-selected");
  const selected: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    usageHistoryRetentionDays: "unlimited",
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("antigravity"),
        enabled: true,
        usageHistoryEnabled: true,
        environment: [{ name: "ANTIGRAVITY_DATA_DIR", value: root, sensitive: false }],
      },
    },
  };
  let current = selected;
  const updates = yield* Queue.unbounded<{
    readonly settings: ServerSettings;
    readonly applied: Deferred.Deferred<void>;
  }>();
  const changes = Stream.fromQueue(updates).pipe(
    Stream.flatMap(({ settings, applied }) =>
      Stream.make(settings).pipe(
        // Pulling past this snapshot acknowledges the subscriber's cache invalidation.
        Stream.concat(Stream.fromEffectDrain(Deferred.succeed(applied, undefined))),
      ),
    ),
  );
  const setSettings = Effect.fn("AntigravityUsage.test.setSettings")(function* (
    settings: ServerSettings,
  ) {
    current = settings;
    const applied = yield* Deferred.make<void>();
    yield* Queue.offer(updates, { settings, applied });
    yield* Deferred.await(applied);
  });
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let paused = false;
  let rootReads = 0;
  let historyReads = 0;
  const pause = Effect.suspend(() => {
    if (paused) return Effect.void;
    paused = true;
    return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));
  });
  const fileSystem: FileSystem.FileSystem = {
    ...fs,
    realPath: (file) =>
      Effect.sync(() => {
        rootReads += 1;
      }).pipe(
        Effect.andThen(stage === "roots" && file === root ? pause : Effect.void),
        Effect.andThen(fs.realPath(file)),
      ),
    readDirectory: (directory) =>
      Effect.sync(() => {
        historyReads += 1;
      }).pipe(
        Effect.andThen(stage === "history" && directory === root ? pause : Effect.void),
        Effect.andThen(fs.readDirectory(directory)),
      ),
  };
  const context = yield* Layer.build(
    AntigravityUsage.layer.pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      Layer.provide(
        Layer.succeed(ProviderHost.ProviderHost, {
          ...host,
          settings: {
            get: Effect.sync(() => current),
            withSnapshot: (use) => Effect.suspend(() => use(current)),
            changes,
            subscribe: Effect.succeed(changes),
          },
        }),
      ),
    ),
  );
  const usage = Context.get(context, AntigravityUsage.AntigravityUsage);
  return {
    started,
    release,
    addIndexDatabase: SqlClient.SqlClient.pipe(
      Effect.flatMap((sql) => sql.unsafe("CREATE TABLE summaries (id TEXT)")),
      Effect.provide(
        NodeSqliteClient.layer({ filename: path.join(root, "conversation_summaries.db") }),
      ),
      Effect.scoped,
    ),
    reads: () => ({ roots: rootReads, history: historyReads }),
    revoke: setSettings({
      ...selected,
      providerInstances: {
        [instanceId]: { ...selected.providerInstances[instanceId]!, usageHistoryEnabled: false },
      },
    }),
    reenable: setSettings(selected),
    scan: usage.scan({
      instances: [
        {
          instanceId,
          config: undefined,
          environment: { ANTIGRAVITY_DATA_DIR: root },
          configured: true,
        },
      ],
      settings: selected,
      windowStartMs: 0,
      retentionCutoffMs: 0,
    }),
  };
});

const layerTest = TestProviderHost.layer().pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(layerTest)("AntigravityUsage", (it) => {
  it.effect.each(["roots", "history"] as const)(
    "drops a scan revoked during %s I/O and rejects its delayed old settings",
    (stage) =>
      Effect.gen(function* () {
        const fixture = yield* setup(stage);
        const pending = yield* fixture.scan.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.started);
        yield* fixture.revoke;
        yield* Deferred.succeed(fixture.release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(pending), []);
        if (stage === "roots") assert.strictEqual(fixture.reads().history, 0);

        const revokedReads = fixture.reads();
        assert.deepStrictEqual(yield* fixture.scan, []);
        assert.deepStrictEqual(fixture.reads(), revokedReads);

        yield* fixture.addIndexDatabase;
        yield* fixture.reenable;
        const sources = yield* fixture.scan;
        const records = sources.flatMap((source) =>
          (source.files ?? []).flatMap((file) => file.records),
        );
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0]?.totals.uncachedInputTokens, 10);
      }),
  );
});
