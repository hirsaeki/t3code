import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const statCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      stat: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(statCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.stat(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "stat",
                    pathOrDescriptor: String(path),
                    description: "Secret file does not exist yet.",
                  });
                });
              }),
            )
          : fileSystem.stat(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

// Both callers read the empty secret before either repairs it, and the second removal of the
// secret file waits until the first caller has returned its key.
const layerConcurrentEmptyRepairFileSystem = (firstReturned: Deferred.Deferred<void>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const readCountRef = yield* Ref.make(0);
      const removeCountRef = yield* Ref.make(0);
      const readBarrier = yield* Deferred.make<void>();
      const isSecretPath = (path: string) => /[\\/]session-signing-key\.bin$/.test(path);

      return {
        ...fileSystem,
        readFile: (path) =>
          isSecretPath(path)
            ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count > 2
                    ? fileSystem.readFile(path)
                    : Effect.gen(function* () {
                        if (count === 2) {
                          yield* Deferred.succeed(readBarrier, void 0);
                        }
                        yield* Deferred.await(readBarrier);
                        return yield* fileSystem.readFile(path);
                      }),
                ),
              )
            : fileSystem.readFile(path),
        remove: (path, options) =>
          isSecretPath(path)
            ? Ref.updateAndGet(removeCountRef, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count > 1 ? Deferred.await(firstReturned) : Effect.void,
                ),
                Effect.flatMap(() => fileSystem.remove(path, options)),
              )
            : fileSystem.remove(path, options),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerConcurrentEmptyRepairSecretStore = (firstReturned: Deferred.Deferred<void>) =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentEmptyRepairFileSystem(firstReturned)),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ServerSecretStore.layer", (it) => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("creates private files and repairs legacy permissions before reading", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = Option.getOrThrow(Option.fromUndefinedOr(secretStore.directory));
      const isWindows = yield* HostProcess.isWindows;
      const canary = new TextEncoder().encode("test-only-provider-credential");
      for (const write of [secretStore.set, secretStore.create]) {
        yield* write("provider-auth-fixture", canary);
        const secretPath = path.join(directory, "provider-auth-fixture.bin");
        if (!isWindows) {
          assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o700);
          assert.equal((yield* fs.stat(secretPath)).mode & 0o777, 0o600);
          yield* fs.chmod(secretPath, 0o666);
        }
        assert.deepEqual(
          Option.getOrThrow(yield* secretStore.get("provider-auth-fixture")),
          canary,
        );
        if (!isWindows) assert.equal((yield* fs.stat(secretPath)).mode & 0o777, 0o600);
        yield* secretStore.remove("provider-auth-fixture");
        assert.isFalse(yield* fs.exists(secretPath));
      }
      assert.deepEqual(yield* fs.readDirectory(directory), []);
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("secures existing credentials when the store starts, before they are requested", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      const secretPath = path.join(config.secretsDir, "provider-auth-legacy.bin");
      yield* fs.writeFileString(secretPath, "test-only-legacy-secret", { mode: 0o666 });
      const store = yield* ServerSecretStore.make;
      if (!(yield* HostProcess.isWindows)) {
        assert.equal((yield* fs.stat(secretPath)).mode & 0o777, 0o600);
      }
      assert.equal(
        new TextDecoder().decode(Option.getOrThrow(yield* store.get("provider-auth-legacy"))),
        "test-only-legacy-secret",
      );
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("refuses a name that would leave the secrets directory", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const value = new TextEncoder().encode("planted");
      for (const name of ["marker-x/../session-signing-key", "marker-x\\..\\session-signing-key"]) {
        for (const write of [secretStore.create, secretStore.set]) {
          assert.equal((yield* write(name, value).pipe(Effect.flip))._tag, "SecretStoreNameError");
        }
        assert.equal((yield* secretStore.get(name).pipe(Effect.flip))._tag, "SecretStoreNameError");
        assert.equal(
          (yield* secretStore.remove(name).pipe(Effect.flip))._tag,
          "SecretStoreNameError",
        );
      }
      assert.isTrue(Option.isNone(yield* secretStore.get("session-signing-key")));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("replaces an empty persisted secret with a fresh random one", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set("session-signing-key", new Uint8Array());

      const secret = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const persisted = yield* secretStore.get("session-signing-key");

      assert.equal(secret.byteLength, 32);
      assert.deepEqual(Array.from(Option.getOrThrow(persisted)), Array.from(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("keeps the repaired secret when concurrent callers find it empty", () =>
    Effect.gen(function* () {
      const firstReturned = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        yield* secretStore.set("session-signing-key", new Uint8Array());
        const getOrCreate = secretStore
          .getOrCreateRandom("session-signing-key", 32)
          .pipe(Effect.tap(() => Deferred.succeed(firstReturned, void 0)));

        const [first, second] = yield* Effect.all([getOrCreate, getOrCreate], {
          concurrency: "unbounded",
        });
        const persisted = Option.getOrThrow(yield* secretStore.get("session-signing-key"));

        assert.deepEqual(Array.from(first), Array.from(persisted));
        assert.deepEqual(Array.from(second), Array.from(persisted));
      }).pipe(Effect.provide(layerConcurrentEmptyRepairSecretStore(firstReturned)));
    }),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set("session-signing-key", new Uint8Array([1]));

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const fs = yield* FileSystem.FileSystem;
      const directory = Option.getOrThrow(Option.fromUndefinedOr(secretStore.directory));

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
      assert.deepEqual(yield* fs.readDirectory(directory), []);
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );
});
