import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makePrivateFiles } from "./privateFile.ts";

it.effect("does not write secret bytes when private permissions cannot be verified", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filePath = path.join(directory, "credential");
    const privateFiles = yield* makePrivateFiles().pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stat: (resource) => fs.stat(resource).pipe(Effect.map((info) => ({ ...info, mode: 0o666 }))),
      }),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
    const error = yield* privateFiles
      .writePrivateFile(filePath, new TextEncoder().encode("test-only-private-file-secret"))
      .pipe(Effect.flip);
    assert.equal(error._tag, "PrivatePathError");
    assert.equal(yield* fs.readFileString(filePath), "");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("does not write secret bytes when Windows ACL restriction fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executablePath = yield* HostProcess.ExecutablePath;
    const filePath = path.join(yield* fs.makeTempDirectoryScoped(), "credential");
    const privateFiles = yield* makePrivateFiles().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
        ...spawner,
        spawn: () => spawner.spawn(ChildProcess.make(executablePath, ["-e", "process.exit(1)"])),
      }),
    );
    const error = yield* privateFiles
      .writePrivateFile(filePath, new TextEncoder().encode("test-only-windows-secret"))
      .pipe(Effect.flip);
    assert.equal(error._tag, "PrivatePathError");
    assert.equal(yield* fs.readFileString(filePath), "");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("repairs broad directory access and creates an owner-only secret file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const isWindows = yield* HostProcess.isWindows;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filePath = path.join(directory, "credential");
    const powershell = (script: string) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            windowsPowerShellPath(environment),
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            {
              env: { ...environment, T3_TEST_DIRECTORY: directory, T3_TEST_FILE: filePath },
              stdin: "ignore",
              stderr: "inherit",
            },
          ),
        );
        const [output, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (text, part) => text + part,
              ),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(exitCode, 0);
        return output;
      }).pipe(Effect.scoped);
    if (isWindows) {
      yield* powershell(`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:T3_TEST_DIRECTORY
$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:T3_TEST_DIRECTORY -AclObject $acl
`);
    } else {
      yield* fs.chmod(directory, 0o777);
    }
    const privateFiles = yield* makePrivateFiles();
    yield* privateFiles.restrictPrivatePath(directory, "directory");
    yield* privateFiles.writePrivateFile(
      filePath,
      new TextEncoder().encode("test-only-owner-secret"),
    );
    if (isWindows) {
      const output = yield* powershell(`
$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries = @($env:T3_TEST_DIRECTORY, $env:T3_TEST_FILE) | ForEach-Object {
  $acl = Get-Acl -LiteralPath $_
  @{
    owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    protected = $acl.AreAccessRulesProtected
    rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() }
    })
  }
}
@{ current = $current; entries = @($entries) } | ConvertTo-Json -Depth 5 -Compress
`);
      const result = JSON.parse(output);
      assert.lengthOf(result.entries, 2);
      for (const entry of result.entries) {
        assert.equal(entry.owner, result.current);
        assert.isTrue(entry.protected);
        assert.deepEqual(entry.rules, [
          { sid: result.current, type: "Allow", inherited: false, rights: "FullControl" },
        ]);
      }
    } else {
      assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o700);
      assert.equal((yield* fs.stat(filePath)).mode & 0o777, 0o600);
    }
    assert.equal(yield* fs.readFileString(filePath), "test-only-owner-secret");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
