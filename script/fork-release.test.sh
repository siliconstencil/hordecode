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

# --- Behaviour: run the real verify phase against stubs (no network). ---------------------------------
# npm and gh fail on purpose (only the installer step is under test); curl hands out a stub install.sh that
# records the arguments and environment it was started with and then "installs" a horde.
stubs="$work/stubs"; mkdir -p "$stubs" "$work/dev" "$work/preinstalled"
printf '#!/bin/sh\nexit 1\n' > "$stubs/npm"; cp "$stubs/npm" "$stubs/gh"
cat > "$stubs/curl" <<'STUB'
#!/bin/sh
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
cat > "$out" <<'INSTALL'
printf '%s\n' "$@" > "$HOME/args"
env > "$HOME/env"
mkdir -p "$HOME/.hordecode/bin"
printf '#!/bin/sh\necho 0.0.9\n' > "$HOME/.hordecode/bin/horde"; chmod +x "$HOME/.hordecode/bin/horde"
INSTALL
STUB
chmod +x "$stubs/npm" "$stubs/gh" "$stubs/curl"
printf '#!/bin/sh\necho 0.0.9\n' > "$work/preinstalled/horde"; chmod +x "$work/preinstalled/horde"

verify() { # verify <label> [env assignments...]; prints the phase output, leaves the verify dir under $work/dev
  rm -rf "$work/dev/build-worktrees"
  env "$@" HORDECODE_DEV_ROOT="$work/dev" PATH="$stubs:$PATH" bash "$SCRIPT" verify 0.0.9 HEAD 2>&1 || true
}
homes() { find "$work/dev/build-worktrees" -type d -name home 2>/dev/null | head -1; }

out="$(verify MAINTAINER_SECRET=1 HTTPS_PROXY=http://proxy.invalid:3128)"
h="$(homes)"
echo "$out" | grep -q 'ok   installer horde --version = 0.0.9'; check "verify: installer ran and the installed horde reports the version" $?
[ "$(cat "$h/args" 2>/dev/null)" = "$(printf -- '--version\n0.0.9')" ]; check "verify: the installer is pinned with --version <version>" $?
if grep -qE '^(MAINTAINER_SECRET|HTTPS_PROXY)=' "$h/env" 2>/dev/null; then r=1; else r=0; fi; check "verify: maintainer env (secret, proxy) does not reach the installer" $r
grep -q '^PATH=/usr/bin:/bin$' "$h/env" 2>/dev/null; check "verify: installer PATH is the minimal one" $?

out="$(verify HORDECODE_VERIFY_PATH="$work/preinstalled:/usr/bin:/bin")"
h="$(homes)"
echo "$out" | grep -q 'FAIL isolated PATH already resolves a horde binary'; check "verify: guard fails when the isolated PATH already has a horde" $?
[ ! -e "$h/args" ]; check "verify: guard stops before the installer runs" $?

# The script comment names the dropped proxy and CA variables.
grep -q 'HTTPS_PROXY' "$SCRIPT" && grep -q 'SSL_CERT_FILE' "$SCRIPT"; check "script comment mentions the dropped proxy/CA variables" $?

[ "$fails" -eq 0 ]
