import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";

class PrivatePathError extends Schema.TaggedError<PrivatePathError>()("PrivatePathError", {
  resource: Schema.String,
}) {
  override get message(): string {
    return `Could not verify private permissions for ${this.resource}.`;
  }
}

// chmod does not restrict Windows access. Replace and verify the ACL before writing secrets.
// Node may inherit PowerShell 7 module paths that Windows PowerShell cannot load; use its own modules.
// Paths are passed as environment data, not PowerShell code.
const RESTRICT_WINDOWS_ACCESS = `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\\Modules"
$target = $env:T3_PRIVATE_PATH
$directory = $env:T3_PRIVATE_DIRECTORY -eq '1'
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($directory) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', $inheritance, 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
$actual = Get-Acl -LiteralPath $target
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or
    $actual.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $owner -or $rules.Count -ne 1 -or
    $rules[0].IdentityReference -ne $owner -or $rules[0].AccessControlType -ne 'Allow' -or
    $rules[0].FileSystemRights -ne 'FullControl' -or $rules[0].InheritanceFlags -ne $inheritance) {
  throw 'Private permissions were not applied'
}
`;

export const makePrivateFiles = Effect.fn("makePrivateFiles")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const isWindows = yield* HostProcess.isWindows;
  const environment = yield* HostProcess.Environment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const restrictPrivatePath = Effect.fn("restrictPrivatePath")(function* (
    resource: string,
    kind: "file" | "directory",
  ) {
    yield* fileSystem.stat(resource);
    if (!isWindows) {
      const mode = kind === "directory" ? 0o700 : 0o600;
      yield* fileSystem.chmod(resource, mode);
      if (((yield* fileSystem.stat(resource)).mode & 0o777) !== mode) {
        return yield* new PrivatePathError({ resource });
      }
      return;
    }
    const exitCode = yield* spawner
      .spawn(
        ChildProcess.make(
          windowsPowerShellPath(environment),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", RESTRICT_WINDOWS_ACCESS],
          {
            env: {
              ...environment,
              T3_PRIVATE_PATH: resource,
              T3_PRIVATE_DIRECTORY: kind === "directory" ? "1" : "0",
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      )
      .pipe(
        Effect.flatMap((child) => child.exitCode),
        Effect.scoped,
        Effect.timeout("10 seconds"),
      );
    if (exitCode !== 0) return yield* new PrivatePathError({ resource });
  });

  const writePrivateFile = Effect.fn("writePrivateFile")(function* (
    resource: string,
    value: Uint8Array,
  ) {
    const file = yield* fileSystem.open(resource, { flag: "wx", mode: 0o600 });
    yield* restrictPrivatePath(resource, "file");
    yield* file.writeAll(value);
    yield* file.sync;
  }, Effect.scoped);
  return { restrictPrivatePath, writePrivateFile };
});
