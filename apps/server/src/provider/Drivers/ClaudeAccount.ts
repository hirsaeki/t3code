import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const ClaudeAccountConfig = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      organizationUuid: Schema.optional(Schema.String),
      accountUuid: Schema.optional(Schema.Unknown),
    }),
  ),
});

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return path.join(configDir ?? (yield* HostProcess.HomeDirectory), ".claude.json");
});

/** Local account identifiers for snapshot identity and synced plugin discovery. */
export const readClaudeOauthAccount = Effect.fn("readClaudeOauthAccount")(
  function* (accountConfigPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* fileSystem
      .readFileString(accountConfigPath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ClaudeAccountConfig))));
    return config.oauthAccount;
  },
  Effect.orElseSucceed(() => undefined),
);

export const readClaudeOrganizationId = (accountConfigPath: string) =>
  readClaudeOauthAccount(accountConfigPath).pipe(
    Effect.map((account) => account?.organizationUuid?.trim() || undefined),
  );
