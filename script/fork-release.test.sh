#!/usr/bin/env bash
# Test for the verify phase of script/fork-release.sh: the installer check must run in a scrubbed
# environment (env -i, isolated HOME, minimal PATH). Runs without network: it extracts the isolated()
# helper and inspects the phase source. Usage: bash script/fork-release.test.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/fork-release.sh"
fails=0
check() { if [ "$2" = "0" ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

bash -n "$SCRIPT"; check "bash -n" $?

fn="$(sed -n '/^isolated() {/,/^}/p' "$SCRIPT")"
[ -n "$fn" ]; check "isolated() is defined" $?

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/maintainer-bin" "$work/home"
printf '#!/bin/sh\necho 0.1.5\n' > "$work/maintainer-bin/horde"; chmod +x "$work/maintainer-bin/horde"

# A horde on the maintainer PATH is visible outside and invisible inside.
(PATH="$work/maintainer-bin:$PATH"; command -v horde >/dev/null); check "fixture: horde is on the maintainer PATH" $?
inside="$(PATH="$work/maintainer-bin:$PATH" bash -c "$fn; isolated '$work/home' sh -c 'command -v horde || echo none'")"
[ "$inside" = "none" ]; check "isolated PATH does not resolve the maintainer horde" $?

# Only the allow-listed variables survive.
vars="$(HORDECODE_HOME=/x OPENCODE_FOO=1 HTTPS_PROXY=http://p SECRET=1 bash -c "$fn; isolated '$work/home' env" | cut -d= -f1 | sort | tr '\n' ' ')"
case "$vars" in *HORDECODE_*|*OPENCODE_*|*PROXY*|*SECRET*) r=1 ;; *) r=0 ;; esac; check "no maintainer variables leak ($vars)" $r
home="$(bash -c "$fn; isolated '$work/home' sh -c 'echo \$HOME'")"
[ "$home" = "$work/home" ]; check "HOME is the isolated directory" $?
path="$(bash -c "$fn; isolated '$work/home' sh -c 'echo \$PATH'")"
[ "$path" = "/usr/bin:/bin" ]; check "PATH is minimal" $?

# The verify phase uses it for the installer run and for the version check.
phase="$(sed -n '/^phase_verify() {/,/^}/p' "$SCRIPT")"
printf '%s' "$phase" | grep -q 'isolated "\$base/home" bash "\$base/install.sh"'; check "installer runs through isolated()" $?
printf '%s' "$phase" | grep -q 'isolated "\$base/home" "\$base/home/.hordecode/bin/horde" --version'; check "installed binary is checked through isolated()" $?
if printf '%s' "$phase" | grep -qE '(^|[^_a-z])HOME="\$base/home" (bash|"\$base)'; then r=1; else r=0; fi; check "no installer call inherits the maintainer PATH" $r

[ "$fails" -eq 0 ]
