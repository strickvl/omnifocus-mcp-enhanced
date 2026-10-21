#!/bin/bash
# Run locally ON THE MINI as noor after reviewing README.md and both plists.
set -euo pipefail
umask 077
[[ $(/usr/bin/id -un) == noor && "$HOME" == /Users/noor ]] || { echo 'Expected noor on the mini.' >&2; exit 1; }
[[ $(/usr/bin/stat -f %Su /dev/console) == noor ]] || { echo 'A noor desktop session is required.' >&2; exit 1; }
[[ -x /opt/homebrew/bin/node && -d /Applications/OmniFocus.app ]] || { echo 'Expected Node 22 and OmniFocus installation.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
target=/Users/noor/.config/omnifocus-mcp/ops-reliability-20261021
agents=/Users/noor/Library/LaunchAgents
for file in rotate-logs.mjs com.strickvl.omnifocus-gui.plist com.strickvl.omnifocus-log-rotation.plist; do
  [[ -f "$source_dir/$file" && ! -L "$source_dir/$file" ]] || exit 1
  [[ ! -L "$target/$file" ]] || { echo 'Refusing linked ops file.' >&2; exit 1; }
  [[ ! -e "$target/$file" ]] || /usr/bin/cmp -s "$source_dir/$file" "$target/$file" || { echo 'Different installed ops file: review before replacing.' >&2; exit 1; }
done
for label in com.strickvl.omnifocus-gui com.strickvl.omnifocus-log-rotation; do
  /usr/bin/plutil -lint "$source_dir/$label.plist" >/dev/null
  [[ ! -L "$agents/$label.plist" ]] || { echo 'Refusing linked LaunchAgent.' >&2; exit 1; }
  [[ ! -e "$agents/$label.plist" ]] || /usr/bin/cmp -s "$source_dir/$label.plist" "$agents/$label.plist" || { echo 'Different existing LaunchAgent: review before replacing.' >&2; exit 1; }
done
# These dedicated paths must not redirect writes through links.
for directory in /Users/noor/.config /Users/noor/.config/omnifocus-mcp "$target" "$agents"; do
  [[ ! -L "$directory" ]] || { echo 'Refusing linked deployment directory.' >&2; exit 1; }
done
/bin/mkdir -p "$target" "$agents"
/bin/chmod 700 "$target"
for file in rotate-logs.mjs com.strickvl.omnifocus-gui.plist com.strickvl.omnifocus-log-rotation.plist; do
  [[ -e "$target/$file" ]] || /usr/bin/install -m 600 "$source_dir/$file" "$target/$file"
done
for label in com.strickvl.omnifocus-gui com.strickvl.omnifocus-log-rotation; do
  [[ -e "$agents/$label.plist" ]] || /usr/bin/install -m 600 "$source_dir/$label.plist" "$agents/$label.plist"
  if ! /bin/launchctl print "gui/$(/usr/bin/id -u)/$label" >/dev/null 2>&1; then
    /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$agents/$label.plist"
  fi
done
echo 'User agents installed. Check launchctl status and actual OmniFocus readiness separately.'
