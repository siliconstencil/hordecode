# Release procedure

How a Hordecode version goes from a release branch to npm and GitHub. The driver is
`script/fork-release.sh <phase> <version> <sha> [branch]`; every phase writes a log to
`<dev>/reports/<version>/release-<phase>-<stamp>.log`, where `<dev>` is the parent directory of
the repository (override with `HORDECODE_DEV_ROOT`). Upstream's `script/release` (GitHub workflow
dispatch) is not used; releases are built and published locally (see CLAUDE.md, known open items).

## Principles

- One isolated archive per published release: `<dev>/releases/<version>-<sha10>/` holds the
  platform packages, the GitHub assets, the npm tarballs, the source bundle and archive, the
  changelog, the release notes, the path-leak check and a `MANIFEST.md`. After the freeze phase it
  is read-only and `SHA256SUMS.all` covers every file. It is never edited again; a corrected
  release is a new version with a new archive.
- Nothing under `/tmp`. Builds run from a detached worktree under `<dev>/build-worktrees/`;
  `packages/opencode/script/build.ts` scrubs the source tree path and the build phase refuses to
  continue when a binary still contains it (`home-strings.txt` must be all zeros).
- External steps (`push`, `npm`, `github`) run only with `HORDECODE_RELEASE_CONFIRMED=1`, each on
  the maintainer's explicit word. Push goes to `origin` only; the script never force-pushes,
  never deletes and never retags.
- The tagged commit is the released commit: the version bump and the changelog section are
  committed before the build, and `preflight` checks them.

## Phases

| Phase       | What it does                                                                                               | Side effects                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `preflight` | Clean tree, branch head is the sha, package version, changelog section, tag collision, gh and npm sessions | none (read-only)                                   |
| `build`     | Detached worktree, `bun install`, `build.ts` for 12 targets, path-leak check, archive directory            | worktree, `releases/<version>-<sha10>/`            |
| `tag`       | Annotated `v<version>` on the sha with the maintainer identity                                             | local tag                                          |
| `push`      | `git push origin <branch> v<version>`                                                                      | origin (confirmation)                              |
| `npm`       | Dry-run pack if needed, then sequential `npm publish` of 12 platform packages and the meta package          | npm registry (confirmation); `npm/` in the archive |
| `github`    | `gh release create v<version>` with the 12 installer assets and `SHA256SUMS`, notes from the changelog     | GitHub release (confirmation)                      |
| `verify`    | `npm install -g` into an isolated prefix, release `SHA256SUMS` against the archive, installer with an isolated `HOME` | files under `build-worktrees/release-<version>/verify-*` |
| `freeze`    | Bundle with the tag, publication record in `MANIFEST.md`, `SHA256SUMS.all`, `chmod -R a-w`                 | archive becomes read-only                          |
| `status`    | Tag, origin, npm count, GitHub release, archive state                                                      | none                                               |

Do not edit `script/fork-release.sh` while a phase is running: bash reads a script incrementally, so an
edit during the `github` phase of 0.1.2 produced a syntax error after the release had been created.
Patch the script between phases and run `bash -n` on it first.

The registry needs a few minutes to process large tarballs (the Windows packages took longest for
0.1.2); the `npm` phase polls for up to three minutes and the `status` phase can be rerun later.

Sequential npm publishing is deliberate: the parallel publish in `publish.ts` hit `ECONNRESET`
for 0.1.1. Each package is skipped when the registry already has that version, so a failed run is
resumed by running the phase again.

## Checklist

Before the build:

1. All planned items closed; package suites and typechecks green at the release commit; the
   manual `fork-platform-smoke` workflow run for macOS and Windows.
2. `packages/opencode/package.json` version bumped and `CHANGELOG.md` has the `## [<version>]`
   section, both committed on the release branch.
3. `script/fork-release.sh preflight <version> <sha>` passes. A `FAIL tag v<version> exists`
   line means an inherited upstream opencode tag occupies the name (upstream used `v0.1.x` in
   2025); the maintainer removes the local tag by hand, the script never does.

Build and measure:

4. `script/fork-release.sh build <version> <sha>`; confirm `home-strings.txt` is all zeros and the
   smoke version matches.
5. Measurements on the built binary (idle `serve` memory, soak) and the e2e suites; results go to
   `<dev>/reports/<version>/`.
6. `HORDECODE_PUBLISH_DRY_RUN=1 OPENCODE_VERSION=<version> bun run script/publish.ts` from the
   build worktree's `packages/opencode` (preflight 12/12, 13 tarballs).

Publish, each step on the maintainer's word:

7. `tag`, then `HORDECODE_RELEASE_CONFIRMED=1 ... push`.
8. `HORDECODE_RELEASE_CONFIRMED=1 ... npm`.
9. `HORDECODE_RELEASE_CONFIRMED=1 ... github`.
10. `verify`, then `freeze`.

After the release:

11. Site docs deploy, status notes, and the decision on how the release branch lands on `main`.
