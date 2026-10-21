#!/usr/bin/env bash
# Hordecode release procedure: one phase per invocation, every phase logged, every external step
# behind an explicit confirmation. The checklist that goes with it is docs/RELEASE.md.
#
#   script/fork-release.sh <phase> <version> <sha> [branch]
#
# Phases, in order:
#   preflight  read-only checks (tree, version, changelog, tag collision, gh and npm sessions)
#   build      detached worktree under build-worktrees/, all 12 targets, release archive dir
#   tag        annotated tag v<version> on <sha> (local only)
#   push       git push origin <branch> v<version>            (HORDECODE_RELEASE_CONFIRMED=1)
#   npm        sequential npm publish of the 13 packages        (HORDECODE_RELEASE_CONFIRMED=1)
#   github     gh release create with the installer assets      (HORDECODE_RELEASE_CONFIRMED=1)
#   verify     isolated npm install, installer run, asset checksums against the archive
#   freeze     tag bundle, directory-wide SHA256SUMS.all, MANIFEST publication note, read-only
#   status     what is done so far (tag, remote, npm, GitHub, archive)
#
# Layout (HORDECODE_DEV_ROOT defaults to the parent of the repository):
#   <dev>/build-worktrees/release-<version>/src-<sha10>   build worktree (never /tmp)
#   <dev>/releases/<version>-<sha10>/                     the isolated release archive
#   <dev>/reports/<version>/release-<phase>-<stamp>.log   log of every phase run
#
# The script never deletes, moves or renames anything and never force-pushes. The build path is
# scrubbed by packages/opencode/script/build.ts; the build phase refuses to continue when a binary
# still contains the build machine path.
set -euo pipefail

PHASE="${1:-}"
VER="${2:-}"
SHA_IN="${3:-}"
if [ -z "$PHASE" ] || [ -z "$VER" ] || [ -z "$SHA_IN" ]; then
  sed -n '2,20p' "$0"
  exit 2
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEV="${HORDECODE_DEV_ROOT:-$(dirname "$REPO")}"
SHA="$(git -C "$REPO" rev-parse --verify "${SHA_IN}^{commit}")"
SHORT="${SHA:0:10}"
BRANCH="${4:-$(git -C "$REPO" branch --show-current)}"
TAG="v$VER"
GH_REPO="siliconstencil/hordecode"
PKG_DIR="$REPO/packages/opencode"
WT="$DEV/build-worktrees/release-$VER/src-$SHORT"
OUT="$DEV/releases/$VER-$SHORT"
LOGDIR="$DEV/reports/$VER"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOGDIR/release-$PHASE-$STAMP.log"
GIT_ID=(-c user.name=Hank -c user.email=265590493+siliconstencil@users.noreply.github.com)
PLATFORMS=(linux-arm64 linux-x64 linux-x64-baseline linux-arm64-musl linux-x64-musl linux-x64-baseline-musl
  darwin-arm64 darwin-x64 darwin-x64-baseline windows-arm64 windows-x64 windows-x64-baseline)

mkdir -p "$LOGDIR"
exec > >(tee -a "$LOG") 2>&1
echo "== fork-release $PHASE version=$VER sha=$SHA branch=$BRANCH tag=$TAG"
echo "== repo=$REPO out=$OUT worktree=$WT log=$LOG"
echo "== started $(date -u +%Y-%m-%dT%H:%M:%SZ)"

fail() { echo "FAIL: $*"; exit 1; }
need_confirm() {
  [ "${HORDECODE_RELEASE_CONFIRMED:-}" = "1" ] ||
    fail "phase $PHASE changes something outside this machine; run it with HORDECODE_RELEASE_CONFIRMED=1 on the maintainer's word"
}
npm_tag() {
  case "$VER" in
    *-*) [ -n "${HORDECODE_NPM_TAG:-}" ] || fail "pre-release version $VER needs HORDECODE_NPM_TAG (for example beta)"; echo "$HORDECODE_NPM_TAG" ;;
    *) echo latest ;;
  esac
}
published() { npm view "$1@$2" version >/dev/null 2>&1; }

phase_preflight() {
  local ok=0 bad=0
  check() { if eval "$2"; then echo "  ok   $1"; ok=$((ok + 1)); else echo "  FAIL $1"; bad=$((bad + 1)); fi; }
  check "working tree clean" '[ -z "$(git -C "$REPO" status --porcelain)" ]'
  check "HEAD of $BRANCH is $SHORT" '[ "$(git -C "$REPO" rev-parse "$BRANCH")" = "$SHA" ]'
  check "packages/opencode/package.json version is $VER" 'grep -q "\"version\": \"$VER\"" "$PKG_DIR/package.json"'
  check "CHANGELOG.md has a [$VER] section" 'grep -q "^## \[$VER\]" "$REPO/CHANGELOG.md"'
  check "origin is https://github.com/$GH_REPO.git" '[ "$(git -C "$REPO" remote get-url origin)" = "https://github.com/$GH_REPO.git" ]'
  if git -C "$REPO" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    local at; at="$(git -C "$REPO" rev-parse "$TAG^{commit}")"
    if [ "$at" = "$SHA" ]; then echo "  ok   tag $TAG already points to $SHORT"; ok=$((ok + 1))
    else
      echo "  FAIL tag $TAG exists and points to ${at:0:10} ($(git -C "$REPO" log -1 --format='%ad %s' --date=short "$at"))"
      echo "       upstream opencode tags share the v0.1.x range; the maintainer removes the inherited tag: git -C $REPO tag -d $TAG"
      bad=$((bad + 1))
    fi
  else echo "  ok   tag $TAG does not exist yet"; ok=$((ok + 1)); fi
  check "tag $TAG not on origin" '[ -z "$(git -C "$REPO" ls-remote --tags origin "refs/tags/$TAG")" ]'
  check "gh session" 'gh auth status >/dev/null 2>&1'
  check "npm session" 'npm whoami >/dev/null 2>&1'
  check "hordecode@$VER not on npm" '! published hordecode "$VER"'
  check "no GitHub release $TAG" '! gh release view "$TAG" -R "$GH_REPO" >/dev/null 2>&1'
  check "archive dir $OUT absent (build) or complete (later phases)" '[ ! -e "$OUT" ] || [ -f "$OUT/github/SHA256SUMS" ]'
  echo "preflight: $ok ok, $bad failed"
  [ "$bad" -eq 0 ]
}

phase_build() {
  [ -e "$WT" ] && fail "worktree $WT exists"
  [ -e "$OUT" ] && fail "archive $OUT exists"
  git -C "$REPO" worktree add --detach "$WT" "$SHA"
  grep -q "\"version\": \"$VER\"" "$WT/packages/opencode/package.json" || fail "package.json in $SHORT is not $VER; bump and commit first"
  (cd "$WT" && bun install)
  (cd "$WT/packages/opencode" && OPENCODE_VERSION="$VER" bun run script/build.ts)
  local dist="$WT/packages/opencode/dist" leaks=0
  mkdir -p "$OUT/packages" "$OUT/github" "$OUT/source"
  : > "$OUT/home-strings.txt"
  for p in "${PLATFORMS[@]}"; do
    local d="$dist/hordecode-$p" bin
    [ -d "$d" ] || fail "missing $d"
    case "$p" in windows-*) bin="$d/bin/hordecode.exe" ;; *) bin="$d/bin/hordecode" ;; esac
    local n; n="$(grep -a -c "$HOME" "$bin" || true)"
    printf 'hordecode-%s: %s\n' "$p" "$n" >> "$OUT/home-strings.txt"
    [ "$n" -eq 0 ] || leaks=$((leaks + 1))
    tar czf "$OUT/packages/hordecode-$p-$VER.tar.gz" -C "$dist" "hordecode-$p"
    case "$p" in
      linux-*) tar czf "$OUT/github/hordecode-$p.tar.gz" -C "$d/bin" . ;;
      *) (cd "$d/bin" && zip -qr "$OUT/github/hordecode-$p.zip" .) ;;
    esac
  done
  [ "$leaks" -eq 0 ] || fail "$leaks binaries still contain $HOME (see $OUT/home-strings.txt); not shippable"
  echo "smoke: $("$dist/hordecode-linux-x64/bin/hordecode" --version)"
  (cd "$OUT/packages" && sha256sum *.tar.gz > SHA256SUMS)
  (cd "$OUT/github" && sha256sum hordecode-* > SHA256SUMS)
  git -C "$REPO" bundle create "$OUT/source/hordecode-$BRANCH-$SHORT.bundle" "$BRANCH" 2>/dev/null ||
    git -C "$REPO" bundle create "$OUT/source/hordecode-branch-$SHORT.bundle" "$BRANCH"
  git -C "$REPO" archive --format=tar.gz --prefix="hordecode-$VER/" -o "$OUT/source/hordecode-$VER-src-$SHORT.tar.gz" "$SHA"
  (cd "$OUT/source" && sha256sum -- * > SHA256SUMS)
  cp "$REPO/CHANGELOG.md" "$OUT/CHANGELOG.md"
  awk -v v="$VER" '/^## \[/{p=($0 ~ "^## \\[" v "\\]")} p' "$REPO/CHANGELOG.md" > "$OUT/release-notes-$VER.md"
  cat > "$OUT/MANIFEST.md" <<EOF
# Hordecode $VER release archive

Commit: $SHORT ($BRANCH), built $(date -u +%Y-%m-%d) on $(uname -s | tr A-Z a-z)-$(uname -m) from the detached worktree
\`build-worktrees/release-$VER/src-$SHORT\` with \`OPENCODE_VERSION=$VER bun run script/build.ts\` (12 targets).
Phase logs: \`reports/$VER/release-*.log\`.

- \`packages/hordecode-<target>-$VER.tar.gz\`: the twelve platform packages from \`packages/opencode/dist\`; \`packages/SHA256SUMS\`.
- \`github/\`: GitHub release assets in the installer layout (\`hordecode-<target>.tar.gz\` for linux, \`.zip\` for
  darwin and windows, contents of \`bin/\`); \`github/SHA256SUMS\` is uploaded with them.
- \`source/\`: git bundle of \`$BRANCH\` and \`git archive\` of the commit; \`source/SHA256SUMS\`.
- \`home-strings.txt\`: build machine path strings per binary (all 0; build.ts scrubs the source tree path).
- \`CHANGELOG.md\` at this commit; \`release-notes-$VER.md\` is its [$VER] section (GitHub release text).

Status at build time: not tagged, not pushed, not published. The freeze phase appends the publication record.
EOF
  echo "BUILD-DONE $OUT"
}

phase_tag() {
  if git -C "$REPO" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    [ "$(git -C "$REPO" rev-parse "$TAG^{commit}")" = "$SHA" ] && { echo "tag $TAG already on $SHORT"; return; }
    fail "tag $TAG exists on another commit; see preflight"
  fi
  git -C "$REPO" "${GIT_ID[@]}" tag -a "$TAG" "$SHA" -m "Hordecode $VER"
  git -C "$REPO" for-each-ref --format='%(refname:short) %(objecttype) %(*objectname:short) %(taggername)' "refs/tags/$TAG"
}

phase_push() {
  need_confirm
  git -C "$REPO" push origin "$BRANCH" "$TAG"
  git -C "$REPO" ls-remote origin "refs/heads/$BRANCH" "refs/tags/$TAG"
}

phase_npm() {
  need_confirm
  local tag; tag="$(npm_tag)"
  local dist="$WT/packages/opencode/dist"
  [ -d "$dist" ] || fail "no dist in $WT; run the build phase first"
  if [ ! -f "$dist/hordecode/hordecode-$VER.tgz" ]; then
    echo "packing through publish.ts dry run (preflight, meta package, 13 tarballs)"
    (cd "$WT/packages/opencode" && HORDECODE_PUBLISH_DRY_RUN=1 OPENCODE_VERSION="$VER" bun run script/publish.ts)
  fi
  grep -q "\"version\": \"$VER\"" "$dist/hordecode/package.json" || fail "meta package is not $VER"
  mkdir -p "$OUT/npm"
  local names=() p
  for p in "${PLATFORMS[@]}"; do names+=("hordecode-$p"); done
  names+=(hordecode)
  for n in "${names[@]}"; do
    local tgz="$dist/$n/$n-$VER.tgz"
    [ -f "$tgz" ] || fail "missing $tgz"
    [ -f "$OUT/npm/$n-$VER.tgz" ] || cp "$tgz" "$OUT/npm/"
    if published "$n" "$VER"; then echo "already published $n@$VER"; continue; fi
    local try
    for try in 1 2 3; do
      if npm publish "$tgz" --access public --tag "$tag"; then break; fi
      [ "$try" -lt 3 ] || fail "npm publish $n@$VER failed 3 times"
      echo "retry $try for $n in 10 s"; sleep 10
    done
  done
  (cd "$OUT/npm" && sha256sum *.tgz > SHA256SUMS)
  # The registry needs a moment after publish before `npm view` sees the version; poll up to 3 minutes.
  local missing=0 round
  for round in $(seq 1 18); do
    missing=0
    for n in "${names[@]}"; do published "$n" "$VER" || missing=$((missing + 1)); done
    [ "$missing" -eq 0 ] && break
    echo "registry shows $((${#names[@]} - missing))/${#names[@]} so far; waiting 10 s (round $round/18)"; sleep 10
  done
  for n in "${names[@]}"; do published "$n" "$VER" || echo "NOT on registry: $n@$VER"; done
  [ "$missing" -eq 0 ] || fail "$missing packages missing on the registry after 3 minutes"
  echo "npm: ${#names[@]} packages at $VER, dist-tag $tag"
}

phase_github() {
  need_confirm
  gh release view "$TAG" -R "$GH_REPO" >/dev/null 2>&1 && fail "release $TAG already exists"
  [ -f "$OUT/release-notes-$VER.md" ] || fail "missing $OUT/release-notes-$VER.md"
  (cd "$OUT/github" && sha256sum -c SHA256SUMS)
  local flags=(--repo "$GH_REPO" --verify-tag --title "Hordecode $VER" --notes-file "$OUT/release-notes-$VER.md")
  case "$VER" in *-*) flags+=(--prerelease) ;; esac
  gh release create "$TAG" "${flags[@]}" "$OUT"/github/hordecode-* "$OUT/github/SHA256SUMS"
  local n; n="$(gh release view "$TAG" -R "$GH_REPO" --json assets -q '.assets | length')"
  [ "$n" -eq 13 ] || fail "release has $n assets, expected 13"
  echo "github: release $TAG with $n assets"
}

phase_verify() {
  local base="$DEV/build-worktrees/release-$VER/verify-$STAMP" bad=0
  mkdir -p "$base/npm-prefix" "$base/home"
  echo "-- npm install -g into an isolated prefix"
  if npm install -g --prefix "$base/npm-prefix" "hordecode@$VER" >/dev/null 2>&1; then
    local v; v="$("$base/npm-prefix/bin/horde" --version 2>/dev/null || true)"
    [ "$v" = "$VER" ] && echo "  ok   npm horde --version = $v" || { echo "  FAIL npm horde --version = '$v'"; bad=$((bad + 1)); }
  else echo "  FAIL npm install hordecode@$VER"; bad=$((bad + 1)); fi
  echo "-- GitHub release checksums against the archive"
  if gh release download "$TAG" -R "$GH_REPO" -p SHA256SUMS -D "$base" >/dev/null 2>&1 &&
    diff -q "$base/SHA256SUMS" "$OUT/github/SHA256SUMS" >/dev/null; then echo "  ok   SHA256SUMS on GitHub matches the archive"
  else echo "  FAIL SHA256SUMS on GitHub differs or missing"; bad=$((bad + 1)); fi
  echo "-- installer with HOME in an isolated directory"
  if curl -fsSL https://hordecode.com/install -o "$base/install.sh" && HOME="$base/home" bash "$base/install.sh" >"$base/install.log" 2>&1; then
    local iv; iv="$(HOME="$base/home" "$base/home/.hordecode/bin/horde" --version 2>/dev/null || true)"
    [ "$iv" = "$VER" ] && echo "  ok   installer horde --version = $iv" || { echo "  FAIL installer horde --version = '$iv' (see $base/install.log)"; bad=$((bad + 1)); }
  else echo "  FAIL installer run (see $base/install.log)"; bad=$((bad + 1)); fi
  echo "verify: $bad failures; files under $base"
  [ "$bad" -eq 0 ]
}

phase_freeze() {
  [ -f "$OUT/SHA256SUMS.all" ] && fail "$OUT is already frozen"
  [ "$(git -C "$REPO" rev-parse -q --verify "$TAG^{commit}")" = "$SHA" ] || fail "tag $TAG is not on $SHORT"
  git -C "$REPO" bundle create "$OUT/source/hordecode-$TAG-$SHORT.bundle" "$TAG" "$BRANCH"
  (cd "$OUT/source" && sha256sum "hordecode-$TAG-$SHORT.bundle" >> SHA256SUMS && sha256sum -c SHA256SUMS >/dev/null)
  local remote_tag npm_count gh_assets
  remote_tag="$(git -C "$REPO" ls-remote --tags origin "refs/tags/$TAG^{}" | cut -c1-10)"
  npm_count=0; for p in "${PLATFORMS[@]}" ""; do published "hordecode${p:+-$p}" "$VER" && npm_count=$((npm_count + 1)); done
  gh_assets="$(gh release view "$TAG" -R "$GH_REPO" --json assets -q '.assets | length' 2>/dev/null || echo 0)"
  cat >> "$OUT/MANIFEST.md" <<EOF

## Publication record

- Tag: \`$TAG\` -> $SHORT (annotated); on origin: ${remote_tag:-not pushed}.
- npm: $npm_count/13 packages at $VER (\`npm/\` holds the published tarballs, \`npm/SHA256SUMS\`).
- GitHub: https://github.com/$GH_REPO/releases/tag/$TAG with $gh_assets assets.
- \`source/hordecode-$TAG-$SHORT.bundle\`: git bundle carrying the tag and \`$BRANCH\`.

## Archive freeze

Frozen $(date -u +%Y-%m-%d): \`SHA256SUMS.all\` covers every file in this directory (\`sha256sum -c SHA256SUMS.all\`);
all files and directories are read-only (\`chmod -R a-w\`) so the published release stays pristine.
Nothing in this directory is edited after this line.
EOF
  (cd "$OUT" && find . -type f ! -name SHA256SUMS.all | sort | xargs sha256sum > SHA256SUMS.all && sha256sum -c SHA256SUMS.all | { grep -vc ': OK$' || true; } | sed 's/^/not-ok: /')
  chmod -R a-w "$OUT"
  echo "frozen: $(find "$OUT" -type f | wc -l) files, $(find "$OUT" -perm -u+w | wc -l) writable entries"
}

phase_status() {
  echo "-- tag:    $(git -C "$REPO" for-each-ref --format='%(refname:short) %(objecttype) %(*objectname:short)' "refs/tags/$TAG" || true)"
  echo "-- origin: $(git -C "$REPO" ls-remote origin "refs/heads/$BRANCH" "refs/tags/$TAG^{}" | cut -c1-10 | tr '\n' ' ')"
  local n=0; for p in "${PLATFORMS[@]}" ""; do published "hordecode${p:+-$p}" "$VER" && n=$((n + 1)); done
  echo "-- npm:    $n/13 packages at $VER; dist-tag latest = $(npm view hordecode version 2>/dev/null || echo none)"
  echo "-- github: $(gh release view "$TAG" -R "$GH_REPO" --json tagName,assets -q '"\(.tagName) \(.assets | length) assets"' 2>/dev/null || echo "no release $TAG")"
  if [ -d "$OUT" ]; then echo "-- archive: $OUT, $(find "$OUT" -type f | wc -l) files, $([ -f "$OUT/SHA256SUMS.all" ] && echo frozen || echo not frozen)"
  else echo "-- archive: $OUT missing"; fi
}

case "$PHASE" in
  preflight | build | tag | push | npm | github | verify | freeze | status) "phase_$PHASE" ;;
  *) fail "unknown phase $PHASE" ;;
esac
echo "== finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
