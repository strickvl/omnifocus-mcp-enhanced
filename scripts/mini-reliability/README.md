# Private mini reliability operations

Prepared 21 October 2026. These machine-specific templates do not change OmniFocus tasks, MCP authentication, FileVault, the bridge, or the tunnel configuration. Review the fixed noor account and installation paths before using them on another machine. The administrator helper is a manual maintenance step. This folder contains no credentials.

## Install and verify the two user agents

The fixed target is `/Users/noor/.config/omnifocus-mcp/ops-reliability-20261021`. Review both plists and `install-user-agents.sh` before transfer. Transfer this folder privately to a staging directory on the mini. Run the helper there as noor in an existing noor desktop session:

```sh
/opt/homebrew/bin/node --test ./rotate-logs.test.mjs
/bin/bash ./install-user-agents.sh
/bin/launchctl print gui/$(/usr/bin/id -u)/com.strickvl.omnifocus-gui
/bin/launchctl print gui/$(/usr/bin/id -u)/com.strickvl.omnifocus-log-rotation
```

The helper installs only the three named files, refuses to replace any differing existing ops file or LaunchAgent, and loads only missing jobs. It does not modify the existing bridge or tunnel agents. If these new labels already exist with other definitions, inspect those definitions first. Do not overwrite them blindly. Existing loaded jobs also require checking `launchctl print` ProgramArguments against the reviewed plist; an already loaded definition can differ from its on-disk file.

The GUI agent runs `/usr/bin/open -g -a /Applications/OmniFocus.app` once when loaded into the Aqua user session and at later GUI logins. It has no KeepAlive loop. Opening the app does not establish automation permission, sync freshness, or application readiness. Verify a bounded authenticated read through the deployed MCP service separately. This agent cannot unlock FileVault or complete GUI login/setup after reboot.

The rotation agent runs daily at 03:15 in the GUI session, with no restart loop. It does not run immediately on installation. If desired, run one reviewed rotation manually using `/opt/homebrew/bin/node /Users/noor/.config/omnifocus-mcp/ops-reliability-20261021/rotate-logs.mjs`. Check the next scheduled run's `LastExitStatus` in launchctl; this package deliberately adds no fifth long-lived log. Launchd scheduling needs a running user session and does not prove recovery after logout, shutdown, or failed GUI login.

To remove only these additions, boot out each of the two new labels with `launchctl bootout gui/$(id -u)/LABEL`, then remove its reviewed plist. Do not quit OmniFocus or alter the existing MCP/tunnel labels as part of removal.

## Rotation behavior and limits

Only `/Users/noor/Library/Logs/OmniFocusMCP/{stdout.log,stderr.log,tunnel-stdout.log,tunnel-stderr.log}` can be selected by the executable. It accepts no command-line path or environment override. At 5 MiB or more it copies at most the final 8 MiB into a private archive, flushes that archive, then truncates the original descriptor. It preserves the original inode. Launchd stdout/stderr writers using append descriptors continue writing into the live file without a process restart. The tests prove this with an actual child Node process inheriting an open append descriptor across rotation.

Copy-and-truncate has an unavoidable race: writes appended after the captured size and before truncation can be lost. The copy volume is bounded, but filesystem delays mean the time interval has no hard bound. If a source already exceeds 8 MiB, older contents are intentionally omitted from its archive. This is operational log retention, not an audit ledger or backup. Never apply it to the write ledger, credentials, task data, or arbitrary paths. It never signals, pauses, or restarts either service.

Each known log retains at most 14 generated archives of at most 8 MiB each, at most 448 MiB across the four logs. Live logs can grow between daily runs; this is not a hard limit on total disk use or a 14-day guarantee. Below-threshold logs are preserved, missing logs are skipped, and unrelated files are untouched. Retention is by generated timestamp name. Only this tool's exact archive naming pattern is pruned. Existing unrelated archives are outside that bound.

The script enforces user ownership, no symlinks in the selected directory, private directory/file modes, and single-link regular log files. It uses an exclusive lock to reject concurrent runs. A lock containing a PID that the kernel explicitly reports as nonexistent is reclaimed. Live, inaccessible, or malformed locks are refused; inspect malformed locks manually. Launchd serializes this one job; do not run simultaneous manual invocations during stale-lock recovery. A crash after the archive is flushed but before truncation may duplicate content on the next run. It cannot create more than 14 managed archives per log because it prunes before creating the next. A failed/partial archive is removed on ordinary exceptions; an abrupt kill can leave a bounded partial archive, also counted by retention. Inspect nonzero exit status rather than repeatedly deleting locks.

## Administrator maintenance policy (manual)

Read `admin-maintenance-policy.sh` before any `sudo` invocation. It requires root and changes only:

1. `/Library/Preferences/com.apple.SoftwareUpdate` key `AutomaticallyInstallMacOSUpdates` to Boolean false, if not already false.
2. `/Library/Preferences/com.apple.loginwindow` key `autoLoginUser`, deleted only when its exact value is `openclaw`, `id openclaw` fails, and the local directory service explicitly reports that account missing. It checks again immediately before deletion.

Before any mutation, the batch saves exact existing preference-file bytes and typed defaults exports into a newly created root-private `/var/root/omnifocus-maintenance-before.*` directory. Absent domains/files get explicit absent markers. Values are never printed. It does not change downloads, background/security update preferences, FileVault, login credentials, setup state, or authentication. It does not reboot, log out, reload loginwindow, or restart any service. A rerun when settled makes no new backup or preference change. If it fails partway through, inspect the private backup and the two exact keys before retrying. Do not restore whole preference domains blindly because that could overwrite later unrelated changes; restore only the reviewed original keys and their types, or delete a key whose original export proves it absent.

Apple documents separate [Software Update controls](https://support.apple.com/en-ie/guide/mac-help/mchla7037245/27/mac/27), the [`AutomaticallyInstallMacOSUpdates` SoftwareUpdate key](https://developer.apple.com/documentation/devicemanagement/softwareupdate), and [background security updates](https://support.apple.com/en-gb/101591). The script uses the built-in defaults command against the existing system preference domain. A successful defaults write is not proof that an OS version or management policy honors that preference. After the approved run, verify the effective Software Update settings show automatic full macOS installations disabled and downloads/security settings unchanged. A management profile can override local preferences. Keep a prompt, supervised full OS update cadence.

## Local validation

The repository's `npm test` includes the five log-rotation behavior tests alongside server tests. They exercise continuing child stdout writes on the same inode, bounded retention and unrelated file preservation, bounded archive size, rejection of links/concurrent locks, and recovery of a definitely dead PID lock. They also run separately with `node --test rotate-logs.test.mjs` from this directory. Validate both plists with `plutil -lint` and both shell scripts with `bash -n`, and repeat tests using the mini's `/opt/homebrew/bin/node` before installation. These automated tests do not run the administrator helper or install LaunchAgents.
