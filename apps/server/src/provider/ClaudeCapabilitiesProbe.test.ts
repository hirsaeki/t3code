// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
  spawnClaudeProbeThroughEnv,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const hostPath = process.env.PATH;

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
    spawnVia: undefined,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

// A shell trampoline would not do: dash drops the exported function, and the launcher exits 127.
it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "starts a Bash launcher that calls an exported function in the probe's workspace",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      yield* fileSystem.writeFileString(`${workspace}/claude`, '#!/bin/bash\nt3_launch "$@"\n');
      yield* fileSystem.chmod(`${workspace}/claude`, 0o755);
      const child = spawnClaudeProbeThroughEnv({
        command: "claude",
        args: ["--probe"],
        cwd: workspace,
        env: { PATH: `.:${hostPath}`, "BASH_FUNC_t3_launch%%": '() { echo "$PWD $@"; }' },
        // @effect-diagnostics-next-line abortControllerInEffect:off - The launcher exits on its own.
        signal: new AbortController().signal,
      });
      assert.deepEqual(child.spawnargs.slice(0, 3), ["/usr/bin/env", "-C", workspace]);
      const output = yield* Effect.promise(() => child.stdout.setEncoding("utf8").toArray());
      assert.equal(output.join(""), `${workspace} --probe\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads account usage only after opt-in while retaining native model and auth discovery",
  () =>
    Effect.gen(function* () {
      const usage = vi.fn(async () => ({ rate_limits_available: true, rate_limits: {} }));
      const initialization = {
        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
        commands: [],
        models: [{ value: "fixture-model", displayName: "Fixture", description: "" }],
      };
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: async () => initialization,
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
          }) as ReturnType<typeof ClaudeSdk.query>,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped();
      const config = yield* decodeClaudeSettings({ binaryPath: "claude", homePath: configDir });
      const environment = { PATH: (yield* HostProcess.Environment).PATH };
      for (const includeAccountUsage of [undefined, false, true]) {
        const capabilities = yield* probeClaudeCapabilities(
          config,
          environment,
          configDir,
          true,
          includeAccountUsage === undefined ? undefined : Effect.succeed(includeAccountUsage),
        );
        assert.equal(capabilities.email, "dev@example.com");
        assert.equal(capabilities.models?.[0]?.value, "fixture-model");
        assert.equal(capabilities.usage !== undefined, includeAccountUsage === true);
      }
      // A slow initialization must not retain consent that was revoked before the optional request.
      let consent = true;
      query.mockImplementationOnce(
        () =>
          ({
            initializationResult: async () => {
              consent = false;
              return initialization;
            },
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
          }) as ReturnType<typeof ClaudeSdk.query>,
      );
      const revoked = yield* probeClaudeCapabilities(
        config,
        environment,
        configDir,
        true,
        Effect.sync(() => consent),
      );
      assert.equal(revoked.email, "dev@example.com");
      assert.isUndefined(revoked.usage);
      assert.equal(usage.mock.calls.length, 1);
      assert.deepEqual(usage.mock.calls[0], [{ skipBehaviors: true }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the probe subprocess alive while gateway model discovery can finish", () =>
  Effect.gen(function* () {
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          models: [{ value: "gateway/claude-relay", displayName: "Relay", description: "" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
          new Promise((_, reject) => reject(new Error("usage unavailable"))),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped();
    // Claude Code also reads these from settings.json, which is where gateway users set them.
    yield* fileSystem.writeFileString(
      `${configDir}/settings.json`,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      }),
    );
    const capabilities = yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { PATH: (yield* HostProcess.Environment).PATH, CLAUDE_CONFIG_DIR: configDir },
    );
    assert.deepEqual(
      capabilities.models?.map((model) => model.value),
      ["gateway/claude-relay"],
    );
    assert.equal(abortSignal?.aborted, false);
    yield* TestClock.adjust("3 seconds");
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
