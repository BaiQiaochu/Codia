# Windows launch compatibility

## Startup preference migration

Electron 42.3.0 stores the unnamed login item under the application's existing
AppUserModelID (`cn.edu.njust.byoung`). Its setter deletes by registry value name
when `openAtLogin` is false; changing `path` does not select a separate value.
The BYOUNG-to-Codia migration therefore replaces the default value once and
does not issue a following disable/delete.

Automatic migration on a status read is intentionally conservative. It requires:

- The current command is not already registered.
- Electron confirms the default value exactly matches the legacy path/arguments.
- `launchItems` contains exactly one matching user-scope entry, with an explicit
  enabled state of `true`.

Disabled entries, ambiguous duplicates, missing metadata, machine-scope entries,
and separately named legacy entries are left untouched. No historical registry
names are guessed. An explicit enable or disable still changes the default entry.
Repeated reads after successful migration do not write again. Windows path
construction uses `path.win32` even when tests run on another OS.

`tests/login-item-settings.test.ts` models Electron's registry value identity,
command comparison, scope and Task Manager enabled flag. It performs no registry
access. Native Windows upgrade/login behavior remains a separate verification
gate.

Reference: [Electron 42.3.0 Windows implementation](https://github.com/electron/electron/blob/v42.3.0/shell/browser/browser_win.cc#L636-L699).

## MCP stdio launch arguments

Native `.exe` and `.com` commands use direct `spawn` with the original argv array.
POSIX and the existing `resolveWindowsShims: false` mode are unchanged. Windows
PATH/PATHEXT resolution uses Windows path operations.

Batch commands and unresolved extensionless commands retain the `cmd.exe` route.
Their launch plan uses `/d /s /v:off /c`, explicit outer command-line quotes, and
`windowsVerbatimArguments: true` so Node does not re-quote the already encoded
line. Arguments are always quoted, including empty strings. Backslash/quote runs
use the Microsoft CRT convention, followed by cmd metacharacter escaping. Known
`node_modules/.bin/*.cmd` paths receive the established extra escaping layer.
Batch command/argument NUL and line breaks are rejected rather than passed to a
shell; use a native executable for argv containing line breaks.

The cmd escaping and shim selection are adapted from
[cross-spawn 7.0.6](https://github.com/moxystudio/node-cross-spawn/tree/v7.0.6).
Its full MIT copyright and license are retained in `windows-cmd-escape.ts`.
There is no new dependency. The CRT encoder is a linear scan, preserving all
backslashes before quotes and at the end of an argument.

These are launch-planning contracts, not a universal Windows parser guarantee.
Programs may implement a different argv parser. Arbitrary batch bodies can
expand `%variables%`, enable delayed expansion, use `CALL`, or reinterpret `%*`;
installed npm/npx wrappers can also vary. Such downstream transformations cannot
be proved by comparing an encoded string or a synthetic decoder. Prefer a native
executable and script path when a custom wrapper changes its inputs.

References:

- [Node child process: Windows batch files and windowsVerbatimArguments](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
- [Microsoft cmd syntax](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd)
- [Microsoft CRT command-line parsing](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments)

## Verification

Cross-platform focused tests:

```sh
PI_OFFLINE=1 npx vitest run tests/login-item-settings.test.ts tests/mcp-stdio-client.test.ts tests/mcp-windows-spawn.test.ts
```

On a supported Windows development/CI host with the repository's dependencies
already installed, run:

```powershell
$env:PI_OFFLINE = '1'
npx vitest run tests/mcp-windows-native-argv.test.ts
```

The native fixture writes only temporary recorder/wrapper files, launches the
local Node executable, records actual argv, and cleans its temporary directory.
It covers native Node, ordinary `.cmd`/`.bat` forwarding, and a synthetic
npm-style compound forwarding shim, including empty values, Unicode, spaces,
embedded quotes, backslashes, URL query strings, and cmd metacharacters. It does
not use a real MCP provider, the network, registry, or user data. It is skipped
outside Windows. A passing synthetic wrapper does not validate every installed
npm version or third-party batch script; validate the actual deployment wrapper
before making that broader claim.

At this change's Linux verification, the native Windows gate was not run.
No Windows registry, login, or byte-perfect native argv result is claimed.
