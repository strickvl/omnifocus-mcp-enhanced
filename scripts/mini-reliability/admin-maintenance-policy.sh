#!/bin/bash
# PROPOSED ADMINISTRATOR BATCH. Do not run until reviewed by the operator.
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run this reviewed batch as root.' >&2; exit 1; }
software=/Library/Preferences/com.apple.SoftwareUpdate
login=/Library/Preferences/com.apple.loginwindow
change_update=1
current=$(/usr/bin/defaults read "$software" AutomaticallyInstallMacOSUpdates 2>/dev/null || true)
[[ "$current" == 0 ]] && change_update=0
remove_login=0
stored=$(/usr/bin/defaults read "$login" autoLoginUser 2>/dev/null || true)
if [[ "$stored" == openclaw ]] && ! /usr/bin/id openclaw >/dev/null 2>&1; then
  record=$(/usr/bin/dscl . -read /Users/openclaw 2>&1 || true)
  if [[ "$record" == *eDSRecordNotFound* ]]; then remove_login=1; fi
fi
if [[ "$change_update" == 0 && "$remove_login" == 0 ]]; then
  echo 'Requested preferences already settled; no changes.'
  exit 0
fi
backup=$(/usr/bin/mktemp -d /var/root/omnifocus-maintenance-before.XXXXXXXX)
/bin/chmod 700 "$backup"
# Save exact on-disk bytes and typed defaults exports before the first mutation.
for domain in "$software" "$login"; do
  base=${domain##*/}
  if [[ -L "$domain.plist" ]]; then echo 'Refusing linked preferences file.' >&2; exit 1; fi
  if [[ -f "$domain.plist" ]]; then
    /bin/cp -p "$domain.plist" "$backup/$base.original.plist"
    /bin/chmod 600 "$backup/$base.original.plist"
  else
    : > "$backup/$base.original-absent"
  fi
  if ! /usr/bin/defaults export "$domain" "$backup/$base.effective.plist" >/dev/null 2>&1; then
    # Existing preferences must be exportable. An absent domain has no keys to save.
    [[ ! -f "$domain.plist" ]] || { echo 'Preference backup failed; no changes.' >&2; exit 1; }
    : > "$backup/$base.effective-absent"
  fi
  [[ ! -f "$backup/$base.effective.plist" ]] || /bin/chmod 600 "$backup/$base.effective.plist"
done
if [[ "$change_update" == 1 ]]; then
  /usr/bin/defaults write "$software" AutomaticallyInstallMacOSUpdates -bool false
  [[ $(/usr/bin/defaults read "$software" AutomaticallyInstallMacOSUpdates) == 0 ]]
fi
if [[ "$remove_login" == 1 ]]; then
  # Recheck the exact condition immediately before deletion.
  [[ $(/usr/bin/defaults read "$login" autoLoginUser 2>/dev/null || true) == openclaw ]]
  ! /usr/bin/id openclaw >/dev/null 2>&1
  record=$(/usr/bin/dscl . -read /Users/openclaw 2>&1 || true)
  [[ "$record" == *eDSRecordNotFound* ]]
  /usr/bin/defaults delete "$login" autoLoginUser
fi
printf 'Requested preferences applied. Private originals: %s\n' "$backup"
