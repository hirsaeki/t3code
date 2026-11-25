import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as TextGenerators from "./TextGenerators.ts";

const selectedId = ProviderInstanceId.make("selected-account");
const alternateId = ProviderInstanceId.make("alternate-account");
const apiId = ProviderInstanceId.make("explicit-api");
const driver = ProviderDriverKind.make("codex");

const makeFixture = Effect.fn("TextGeneration.test.makeFixture")(function* (
  state: "quota" | "disabled",
) {
  const calls: string[] = [];
  const orchestrationAdapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
    Effect.provide(Layer.mock(ProviderAdapter.ProviderAdapterV2)({})),
  );
  const runner: TextGenerationOperations.Runner = (request) => {
    calls.push(request.modelSelection.instanceId);
    return TextGenerationOperations.decodeJsonReply(
      request,
      "Fixture",
      JSON.stringify({ branch: request.modelSelection.instanceId }),
    );
  };
  const instances = [selectedId, alternateId].map((instanceId): ProviderInstance => {
    const snapshot: ServerProvider = {
      instanceId,
      driver,
      enabled: instanceId !== selectedId || state !== "disabled",
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", type: "chatgpt" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [{ slug: "fixture-model", name: "Fixture", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
      ...(instanceId === selectedId
        ? {
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00.000Z",
              windows: [{ id: "primary", kind: "session", label: "Plan", usedPercent: 100 }],
            },
          }
        : {}),
    };
    return {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: instanceId },
      displayName: undefined,
      enabled: snapshot.enabled,
      snapshot: {
        getSnapshot: Effect.succeed(snapshot),
        refresh: Effect.succeed(snapshot),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () => Effect.die("unused"),
      },
      orchestrationAdapter,
      textGeneration: TextGenerationOperations.fromRunner("Fixture", runner),
    };
  });
  const service = yield* TextGeneration.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed(instances),
          getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            defaultModelSelection: { instanceId: alternateId, model: "fixture-model" },
            providerInstances: {
              [selectedId]: { driver, enabled: state !== "disabled", config: {} },
              [alternateId]: { driver, enabled: true, config: {} },
            },
          }),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({}),
        ProviderInstallationGate.layer,
        Layer.mock(TextGenerators.TextGenerators)({
          runner: (id) => Effect.succeed(id === apiId ? runner : undefined),
        }),
      ),
    ),
  );
  return { service, calls };
});

it.effect("an exhausted subscription does not invoke another signed-in account", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeFixture("quota");
    const error = yield* service
      .generateBranchName({
        cwd: process.cwd(),
        message: "Name a branch",
        modelSelection: { instanceId: selectedId, model: "fixture-model" },
      })
      .pipe(Effect.flip);
    assert.include(error.detail, "usage limit");
    assert.deepEqual(calls, []);
    for (const instanceId of [alternateId, apiId]) {
      const result = yield* service.generateBranchName({
        cwd: process.cwd(),
        message: "Name a branch",
        modelSelection: { instanceId, model: "fixture-model" },
      });
      assert.equal(result.branch, instanceId);
    }
    assert.deepEqual(calls, [alternateId, apiId]);
  }),
);

it.effect("keeps fallback for an explicitly disabled provider with an old quota report", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeFixture("disabled");
    yield* service.generateBranchName({
      cwd: process.cwd(),
      message: "Name a branch",
      modelSelection: { instanceId: selectedId, model: "fixture-model" },
    });
    assert.deepEqual(calls, [alternateId]);
  }),
);
