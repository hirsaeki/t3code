import {
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  CURSOR_MIN_FETCH_SPAN_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import { readStoredCursorApiKey } from "./credentialStore.ts";

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

const decodeCacheFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

export class CursorUsageAccounts extends Context.Service<
  CursorUsageAccounts,
  {
    readonly scan: (input: {
      readonly instances: ReadonlyArray<{
        readonly instanceId: ProviderInstanceId;
        readonly environment: NodeJS.ProcessEnv;
      }>;
      readonly windowStartMs: number;
      readonly retentionCutoffMs: number;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
    readonly awaitPersisted: Effect.Effect<void>;
    readonly invalidate: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  }
>()("@t3tools/provider-cursor/server/CursorUsageAccounts") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const accountReader = yield* CursorAccountReader.CursorAccountReader;
  const digest = yield* Digest.Digest;
  const hostEnvironment = yield* HostProcess.Environment;

  const cachePath = path.join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  const caches = new Map<string, CursorAccountCache>();
  let cacheDirty = false;
  /** Failed refreshes share the cache TTL to prevent repeated requests; null means no login. */
  const failures = new Map<string, { readonly atMs: number; readonly error: string | null }>();
  const refreshes = new Map<string, Deferred.Deferred<void>>();
  /** Widest range the next read asks for, narrowed after failures until the cache is complete. */
  const fetchSpans = new Map<string, number>();

  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeCacheFile(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        // A malformed or empty persisted document must not survive a revoke or restart.
        cacheDirty = true;
        for (const [key, cache] of decodeCursorAccountCaches(document)) caches.set(key, cache);
      }),
    ),
  );

  let generation = 0;
  const instanceKeys = new Map<ProviderInstanceId, string>();
  let activeKeys = new Set<string>();
  let retentionDays: ServerSettings["usageHistoryRetentionDays"] | undefined;
  let currentRetentionStartMs = 0;
  const keyOf = (apiKey: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(apiKey))
      .pipe(Effect.map((bytes) => `api-key:${Hex.encode(bytes)}`));
  const reconcileCredentials = Effect.fn("CursorUsageAccounts.reconcileCredentials")(function* (
    snapshot?: ServerSettings,
  ) {
    yield* ensureLoaded;
    const settings = snapshot ?? (yield* host.settings.get.pipe(Effect.orElseSucceed(() => null)));
    const entries = Object.entries(settings?.providerInstances ?? {}).filter(
      ([, instance]) =>
        instance.driver === "cursor" &&
        instance.accountUsageEnabled === true &&
        resolveProviderInstanceEnabled(instance),
    );
    const credentials = yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([id, instance]) {
        const instanceId = ProviderInstanceId.make(id);
        const environment = yield* mergeProviderInstanceEnvironment(
          instance.environment,
          hostEnvironment,
        );
        const apiKey =
          environment.CURSOR_API_KEY?.trim() ||
          (yield* readStoredCursorApiKey(instanceId).pipe(
            Effect.provideService(ProviderHost.ProviderHost, host),
            Effect.orElseSucceed(() => undefined),
          ));
        return apiKey ? { instanceId, apiKey, key: yield* keyOf(apiKey) } : null;
      }),
    );
    const next = credentials.filter((credential) => credential !== null);
    const keys = new Set(next.map((credential) => credential.key));
    const nextRetentionDays = settings?.usageHistoryRetentionDays ?? 92;
    if (
      keys.size !== activeKeys.size ||
      [...activeKeys].some((key) => !keys.has(key)) ||
      retentionDays !== nextRetentionDays
    )
      generation += 1;
    activeKeys = keys;
    retentionDays = nextRetentionDays;
    instanceKeys.clear();
    for (const credential of next) instanceKeys.set(credential.instanceId, credential.key);
    const nowMs = yield* Clock.currentTimeMillis;
    const retentionStartMs =
      nextRetentionDays === "unlimited"
        ? 0
        : Math.max(0, nowMs - nextRetentionDays * 24 * 60 * 60 * 1000);
    currentRetentionStartMs = retentionStartMs;
    for (const [key, cache] of caches) {
      if (!keys.has(key)) {
        caches.delete(key);
        cacheDirty = true;
        continue;
      }
      const records = cache.records.filter((record) => record.timestampMs >= retentionStartMs);
      if (records.length !== cache.records.length) {
        caches.set(key, { ...cache, records, sinceMs: Math.max(cache.sinceMs, retentionStartMs) });
        cacheDirty = true;
      }
    }
    for (const key of failures.keys()) if (!keys.has(key)) failures.delete(key);
    for (const key of fetchSpans.keys()) if (!keys.has(key)) fetchSpans.delete(key);
    return next;
  });

  // Serialize snapshots; clear dirty before encoding and restore it on failure so changes retry.
  const persistLock = yield* Semaphore.make(1);
  const persist = host.settings
    .withSnapshot((settings) =>
      Effect.gen(function* () {
        yield* reconcileCredentials(settings);
        if (!cacheDirty) return;
        cacheDirty = false;
        yield* (
          caches.size === 0
            ? fileSystem.remove(cachePath).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  () => Effect.void,
                ),
              )
            : Effect.sync(() => encodeCursorAccountCaches(caches)).pipe(
                Effect.flatMap((contents) =>
                  writeFileStringAtomically({ filePath: cachePath, contents }),
                ),
              )
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catchCause(() =>
            Effect.sync(() => {
              cacheDirty = true;
            }),
          ),
        );
      }),
    )
    .pipe(
      persistLock.withPermit,
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
      Effect.withSpan("CursorUsageAccounts.persist"),
    );

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.andThen(
    persist,
    Effect.suspend(() => Fiber.awaitAll([...pendingPersists])),
  ).pipe(Effect.asVoid);
  yield* Effect.addFinalizer(() => awaitPersisted);

  const refreshLock = yield* Semaphore.make(2);
  const refreshAccount = Effect.fn("CursorUsageAccounts.refreshAccount")(function* (
    credential: CursorCredentialSource,
    credentialKey: string,
    requestedRetentionStartMs: number,
  ) {
    yield* reconcileCredentials();
    if (!activeKeys.has(credentialKey)) return;
    const retentionStartMs = Math.max(requestedRetentionStartMs, currentRetentionStartMs);
    const refreshGeneration = generation;
    const nowMs = yield* Clock.currentTimeMillis;
    let checkedAccount = false;
    let span = fetchSpans.get(credentialKey) ?? Number.POSITIVE_INFINITY;
    // Widen after each success so a span narrowed by earlier failures recovers in a few reads.
    let widening = true;
    let widened = false;
    for (;;) {
      yield* reconcileCredentials();
      if (generation !== refreshGeneration || !activeKeys.has(credentialKey)) {
        yield* schedulePersist;
        return;
      }
      const base = caches.get(credentialKey);
      const range = cursorFetchRange(base, retentionStartMs, nowMs, span);
      const result = yield* accountReader.read(credential, range.sinceMs, range.untilMs);
      yield* reconcileCredentials();
      if (generation !== refreshGeneration || !activeKeys.has(credentialKey)) {
        yield* schedulePersist;
        return;
      }
      if (
        !checkedAccount &&
        base !== undefined &&
        result.accountKey !== null &&
        result.accountKey !== base.accountKey
      ) {
        caches.delete(credentialKey);
        cacheDirty = true;
        checkedAccount = true;
        continue;
      }
      checkedAccount = true;
      if (result.missing || result.error !== null || result.accountKey === null) {
        if (result.missing || result.accountKey === null) {
          if (caches.delete(credentialKey)) cacheDirty = true;
        }
        // A large account's full history can outlast the read deadlines; try a narrower range.
        span = Math.max(CURSOR_MIN_FETCH_SPAN_MS, (range.untilMs - range.sinceMs) / 2);
        fetchSpans.set(credentialKey, span);
        if (widened) {
          // The span before widening just worked: keep going with it instead of failing.
          widened = false;
          widening = false;
          continue;
        }
        failures.set(credentialKey, {
          atMs: nowMs,
          error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
        });
        yield* schedulePersist;
        return;
      }
      const merged = mergeCursorFetch(
        base,
        result.accountKey,
        range,
        result.records,
        nowMs,
        retentionStartMs,
      );
      caches.set(credentialKey, merged.cache);
      failures.delete(credentialKey);
      if (merged.changed) cacheDirty = true;
      yield* schedulePersist;
      if (merged.cache.sinceMs <= retentionStartMs && merged.cache.untilMs >= nowMs) break;
      widened = widening && Number.isFinite(span);
      if (widened) {
        span *= 2;
        fetchSpans.set(credentialKey, span);
      }
    }
    fetchSpans.delete(credentialKey);
  }, refreshLock.withPermit);

  const startRefresh = (
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    // Enroll and fork atomically so interruption cannot strand a registered refresh.
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = refreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        refreshes.set(credentialKey, done);
        // Detached: a departing client must not cancel a fetch later reads reuse.
        yield* refreshAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) => {
                if (activeKeys.has(credentialKey))
                  failures.set(credentialKey, { atMs, error: CURSOR_ACCOUNT_READ_ERROR });
              }),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              refreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  const accountSource = Effect.fn("CursorUsageAccounts.accountSource")(function* (
    credential: CursorCredentialSource,
    windowStartMs: number,
    requestedRetentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    yield* ensureLoaded;
    const sourceGeneration = generation;
    const retentionStartMs = Math.max(requestedRetentionStartMs, currentRetentionStartMs);
    const credentialKey = yield* keyOf(credential.apiKey);
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = failures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(caches.get(credentialKey), nowMs, retentionStartMs)
    ) {
      const refresh = yield* startRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) {
        yield* Deferred.await(refresh);
        yield* reconcileCredentials();
        if (sourceGeneration !== generation) return null;
        if (
          !failures.has(credentialKey) &&
          !isCursorCacheFresh(caches.get(credentialKey), nowMs, retentionStartMs)
        ) {
          const retry = yield* startRefresh(credential, credentialKey, retentionStartMs);
          yield* Deferred.await(retry);
        }
      } else refreshing = true;
    }

    const cache = caches.get(credentialKey);
    const failure = refreshing ? undefined : failures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        dir: "cursor-account",
        ...(refreshing
          ? { files: [], refreshing: true }
          : { files: null, message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
      } satisfies ProviderUsageScan;
    }
    // Account history spans machines; a stable fingerprint prevents duplicate environment counts.
    const source = `cursor-account:${cache.accountKey}`;
    return {
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
        },
      ],
      ...(failureMessage === undefined
        ? { status: "ok" }
        : { status: "partial", message: failureMessage }),
      ...(refreshing ? { refreshing: true } : {}),
    } satisfies ProviderUsageScan;
  });

  const scan: CursorUsageAccounts["Service"]["scan"] = Effect.fn("CursorUsageAccounts.scan")(
    function* ({ instances, windowStartMs, retentionCutoffMs, awaitRefresh }) {
      const selected = new Set(instances.map((instance) => instance.instanceId));
      const credentials = yield* reconcileCredentials();
      yield* persist;
      const uniqueApiKeys = [
        ...new Set(
          credentials
            .filter((credential) => selected.has(credential.instanceId))
            .map((credential) => credential.apiKey),
        ),
      ];
      if (uniqueApiKeys.length > 0) {
        const scanGeneration = generation;
        const sources: ReadonlyArray<ProviderUsageScan | null> = yield* Effect.forEach(
          uniqueApiKeys,
          (apiKey) =>
            accountSource(
              { kind: "apiKey", apiKey },
              windowStartMs,
              retentionCutoffMs,
              awaitRefresh,
            ),
          { concurrency: 2 },
        );
        yield* reconcileCredentials();
        if (generation !== scanGeneration) {
          yield* persist;
          return [];
        }
        // Keys for one account share its source, and a repeated source would count sessions twice.
        // A failed key can hold older records, so a current read wins, then a refresh the client
        // must follow up on.
        const rank = (source: ProviderUsageScan) =>
          source.status === "ok" ? 2 : source.refreshing ? 1 : 0;
        const byAccount = new Map<string, ProviderUsageScan>();
        for (const source of sources) {
          if (source === null) continue;
          const kept = byAccount.get(source.dir);
          if (kept === undefined || rank(source) > rank(kept)) {
            byAccount.set(source.dir, source);
          }
        }
        return [...byAccount.values()];
      }
      return [];
    },
  );

  const invalidate = Effect.fn("CursorUsageAccounts.invalidate")(function* (
    instanceId: ProviderInstanceId,
  ) {
    generation += 1;
    const key = instanceKeys.get(instanceId);
    if (key !== undefined) {
      caches.delete(key);
      failures.delete(key);
      fetchSpans.delete(key);
      cacheDirty = true;
    }
    yield* persist;
  });
  const settingsChanges = yield* host.settings.subscribe;
  yield* reconcileCredentials();
  yield* persist;
  yield* settingsChanges.pipe(
    Stream.runForEach((settings) => reconcileCredentials(settings).pipe(Effect.andThen(persist))),
    Effect.forkScoped,
  );

  return CursorUsageAccounts.of({ scan, awaitPersisted, invalidate });
});

export const layer = Layer.effect(CursorUsageAccounts, make);
