# Tests

Tests are grouped by responsibility: `cli/` for command-line behavior,
`config/` for configuration and environment contracts, `execution/` for plans,
processes and artifacts, `product/` for identity/version behavior,
`runtime/` for snapshot semantics and cross-host conformance, `unplugin/` for
host integration boundaries, and `typegen/` for declaration generation and
host preparation. Shared build harnesses stay in `helpers/`; executable fixture
programs stay in `fixtures/`.

## Compatibility matrix

Supported host ranges are declared in [package.json](../package.json).
[compatibility-matrix.json](../scripts/compatibility-matrix.json) is the single
source of exact package-test versions, Electron combinations, and typecheck
settings. Both package test runners use profiles selected from this file.

### CI environments

The [CI workflow](../.github/workflows/ci.yml) runs independent code/docs jobs on one source SHA. The docs job always checks/builds a read-only artifact; the code job retains these checks for code changes:

| OS                     | Node           | Checks                                                      |
| ---------------------- | -------------- | ----------------------------------------------------------- |
| Ubuntu                 | 24.x           | Unit tests and packaged consumers with the full profile     |
| Ubuntu                 | 22.18.0        | Unit tests and packaged consumers with the daily profile    |
| macOS, Windows         | 22.18.0 / 24.x | Unit tests and packaged consumers with the platform profile |
| Ubuntu, macOS, Windows | 24.x           | Real Electron/Web acceptance in three independent jobs      |

Documentation-only changes run lint, product wiring checks and relevant
site checks. Commit titles never skip CI or documentation builds. Manual CI always
runs code checks; `full` expands the package profile on every OS/Node combination.

CI and Publish share `checks.yml` rather than duplicate product matrices. Publish first queries successful complete CI at the exact native SHA, including all six compatibility and three Electron jobs. Without qualifying evidence it runs the complete product workflow before calling shared release orchestration. Missing or reduced docs-only CI, query failure and timeout require full fallback; fatal lookup inputs block publication. Complete fallback must succeed and return the native SHA. Necessary code, release notes and migration files are allowed; no version-only commit or parent-CI exception remains.

The shared flow checks the native candidate, builds documentation, runs `pnpm build` after complete product checks on that SHA, packs with pnpm lifecycle scripts disabled and tests that same TARBALL using the daily profile before publication. It does not repeat lint/types/examples in the publishing job. Provider policy runs inside the configured environment/concurrency gate. Publish/recovery read identical settings from `.github/xova.json`; manual Publish does not deploy.

`docs-recover.yml` is one shared recovery call. Operators confirm the published SHA and select its release tag. Shared source validation runs before rebuilding or waiting for deployment approval. Recovery creates a new artifact and never invokes npm publication.

Native release-it uses the pinned preparation preset in `.release-it.json`. Preview with an explicit version and `--dry-run`; the preset disables Git delivery and publication. The official plugin may stage a newly created changelog. Preserve partial preparation results on failure.

`test/scripts/release-workflows.test.js` checks only Matrix matrices, CI-reuse/fallback wiring and `.github/xova.json` settings. Explicit local toolkit binding also validates that configuration with the shipped parser for all five tasks and compares Publish to the pinned toolkit example. Shared calls use configuration defaults without command/setup overrides; the separate query job alone adds actions:read and tolerates recoverable failures. Fatal input reporting, complete product checks and publication remain blocking. Check/build grants remain read-only and recovery keeps the Pages permission boundary. Generic runners, fake publishers and upstream fixture tests stay in Xova Actions. Shared quality checks run product wiring tests for both code and documentation-only changes. Code uses `release:check`; the docs-only path runs lint. Quality success gates the product matrices; final publication never uses docs-only optimization.

All shared workflow and action calls pin the same full toolkit SHA whose remote CI has passed. Normal `mise exec -- pnpm check` needs no local toolkit binding. Optionally use `XOVA_ACTIONS_ROOT=../actions mise exec -- pnpm check` with that toolkit revision to validate the actual workflow/action contracts and configuration parser as well. Binding verification rejects a different HEAD or modified tracked files/index before reading contracts. Preparation remains independently pinned. Local fixtures and toolkit CI do not prove nested required-check names, Matrix-hosted execution, OIDC or deployment acceptance.

The first three rows expand to six jobs. Every package profile includes the
host-free CLI consumer and all three Electron type-preparation combinations.
POSIX process-group shutdown assertions run on Ubuntu and macOS; Windows runs
the remaining checks. The separate Node 24 quality job runs lint, typecheck,
build, and example checks. Electron acceptance starts independently of host tests.
Compatibility jobs include the lockfile and compatibility manifest in their
cache keys. Shared setup selects only pnpm from setup.cache and documentation inherits it; cache paths and lock patterns are owned by the shared toolkit. Full host verification runs on Ubuntu / Node 24 for every code change.
Compatibility jobs also cache npm's download store for the CLI consumer;
Electron jobs cache the binary archives used by the explicit Electron installer.
These caches use OS / architecture and dependency-manifest keys, with same-platform
fallbacks. Installation, checksum validation, builds, and tests still run on cache
hits. Consumer directories, node_modules, and build outputs are not cached.

Compatibility and Electron acceptance steps set TMPDIR/TEMP/TMP to runner.temp so Windows temporary consumers stay on the checkout volume and reuse its pnpm store. Workflow wiring tests execute Node's real temporary-directory selection with conflicting system defaults. Local checks do not establish Windows cache transport or download counts; those require a hosted Windows run. Shared quality checks do not select npm caching because they run pnpm commands; actual npm consumers retain their product-owned download cache.

Only Electron jobs narrow the root install with `pnpm --filter @xova/matrix --fail-if-no-match install --frozen-lockfile`. This retains root build tools and development dependencies without installing documentation or example workspaces there. `test:electron-web` still packs the current source and installs the example's complete locked dependencies in a separate consumer before preparation, both development runs and all three packaged application runs. Quality and compatibility jobs retain full workspace installation. Workflow wiring tests guard this distinction.

Vitest retains its default worker concurrency and per-file isolation. Compare the same heavy files with `pnpm exec vitest run <files> --isolate`, then repeat with `--maxWorkers 2` or `--maxWorkers 1` in alternating order. Keep the pool, test cases and dependencies unchanged and run comparisons sequentially. Lower concurrency must show a repeatable benefit on the target runner before adoption; local macOS timings do not establish hosted performance.

### Package profiles

All profiles select versions from the same exact-version manifest:

| Profile  | Vite                                | Rollup                              | Webpack                | esbuild                                             | Electron combinations | Total consumers |
| -------- | ----------------------------------- | ----------------------------------- | ---------------------- | --------------------------------------------------- | --------------------- | --------------- |
| daily    | Each major's first and last pin (8) | Each major's first and last pin (6) | First and last pin (2) | Last pin of every minor plus the support floor (18) | 3                     | 37              |
| platform | Overall first and last pin (2)      | Overall first and last pin (2)      | First and last pin (2) | Overall first and last pin (2)                      | 3                     | 11              |
| full     | 34                                  | 10                                  | 23                     | 32                                                  | 3                     | 102             |

Counts exclude the shared CLI-only consumer. First/last refer to the pinned
manifest, not a dynamically fetched registry version. Support ranges do not
change with the selected profile. Vite 8 consumers explicitly install the WASM
runtime peers pinned in the manifest, with strict peer checks still enabled.
The host workspace pins `schema-utils` to `4.5.0`, the version in the repository
lockfile, through `hostWorkspaceOverrides`. This keeps historical Webpack fixtures
reproducible after `schema-utils@4.8.1` added a `webpack ^5.112.0` peer. Strict peer
checks remain enabled; published dependencies and host support ranges do not change.

- Ubuntu / Node 24: `pnpm test:pack`; Ubuntu / Node 22: `pnpm test:pack --profile daily`.
- Daily macOS/Windows: `pnpm test:pack --profile platform`.
- Full local verification: `pnpm test:pack` (defaults to `full`).
- Full cross-platform verification: manually dispatch CI with `full` enabled.

CI and Publish each run the full profile on their own Ubuntu / Node 24 candidate. Consumers run with concurrency 2;
`--concurrency 1` runs serially and values up to 4 are supported. Each consumer's
prepare, typecheck, and build phases remain sequential. Failures are collected
before removing temporary workspaces. Logs record install, prepare, typecheck,
and build durations, followed by elapsed wall time and the five slowest
consumers. Phase totals are cumulative and can exceed wall time under concurrency.

### Published-package hosts

`pnpm test:pack` consumes an absolute `TARBALL` when supplied, otherwise packs Matrix once, then installs the tarball into temporary
consumers. The publication workflow supplies the already packed candidate and runs the daily profile; it never repacks during that check. Host versions coexist in pnpm workspaces with automatic peer
installation and workspace-root peer resolution disabled.

| Host    | Version lines                                            | Pinned versions | Runner                   |
| ------- | -------------------------------------------------------- | --------------: | ------------------------ |
| Vite    | 5.1–5.4, 6.0–6.4, 7.0–7.3, 8.0–8.3                       |              34 | `scripts/pack-vite.mjs`  |
| Rollup  | 2.68, 2.70, 2.71, 2.79; 3.0, 3.29; 4.0, 4.38, 4.40, 4.64 |              10 | `scripts/pack-hosts.mjs` |
| Webpack | 5.100–5.111, starting at 5.100.1                         |              23 | `scripts/pack-hosts.mjs` |
| esbuild | 0.12–0.28                                                |              32 | `scripts/pack-hosts.mjs` |

Every version selected by a profile runs its row's checks below. A dash means that the check
is outside this package matrix; it is not a compatibility claim.

| Check                                                     | Vite | Rollup / Webpack / esbuild | electron-vite             |
| --------------------------------------------------------- | ---- | -------------------------- | ------------------------- |
| Plugin types with `skipLibCheck: false`                   | Yes  | Yes                        | Yes                       |
| Consumer host resolution                                  | Yes  | Yes                        | Through electron-vite     |
| `matrix prepare`                                          | Yes  | —                          | main / preload / renderer |
| Development transform                                     | Yes  | —                          | —                         |
| Production build and executed output                      | Yes  | Yes                        | —                         |
| Inlining enabled and disabled                             | Yes  | Yes                        | —                         |
| Frozen runtime, public fields, development-branch removal | Yes  | Yes                        | —                         |
| Direct-write build diagnostic                             | —    | Yes                        | —                         |
| Generated declarations                                    | Yes  | Yes                        | Scope isolation           |
| Application startup                                       | —    | —                          | —                         |

The shared typecheck baseline is TypeScript 5.9.3, `@types/node` 22.18.0,
ES2022, ESNext modules, Bundler resolution, `strict: true`, and
`skipLibCheck: false`. A separate CLI-only consumer installs none of the four
hosts and verifies exports, configuration isolation, preparation, doctor, and
process shutdown.

### Electron combinations

The package matrix runs these three combinations with Electron 44.4.5 and
`@swc/core` 1.16.13 installed; it does not download or launch Electron:

| electron-vite | Vite  | Checks                                                   |
| ------------- | ----- | -------------------------------------------------------- |
| 2.3.0         | 5.1.0 | Three-context preparation, plugin types, scope isolation |
| 3.1.0         | 6.0.0 | Three-context preparation, plugin types, scope isolation |
| 5.0.0         | 7.0.0 | Three-context preparation, plugin types, scope isolation |

`pnpm test:electron-web` separately tests real development, builds, and
application startup using the locked
[Electron/Web example](../examples/electron-web/README.md). Its versions are
owned by the example's package manifest and workspace lockfile; this acceptance
run is not repeated for every package-matrix combination.

`scripts/electron-report.test.js` covers missing, malformed, and incorrect
acceptance reports after a successful command exit, including captured stdout
and stderr, product/environment/phase context, exit status, and the quiet success
path. It uses real Node subprocesses and report files; these diagnostics tests
do not replace the real Electron acceptance jobs.

### Updating the matrix

Change exact test pins and shared settings in
`scripts/compatibility-matrix.json`. Update `package.json` only when changing
the supported ranges. Keep this matrix and both integration guides aligned,
then run `pnpm check` and `pnpm test:pack`. Change OS/Node jobs once in
`.github/workflows/checks.yml`; CI and Publish both call that product workflow.

## Automatic declaration safeguards

`execution/doctor.test.ts` covers filesystem-only host config validation, invalid
explicit paths, ambiguous discovery, selection priority, and host-free projects.
The CLI regression rejects missing host configs without printing success; the
host-free packaged consumer also verifies that doctor never loads host configs
or requires optional host dependencies.

`unplugin/index.test.ts` explicitly clears `VITEST` to verify the default
missing-context safeguard through Vite configuration, real Vite builds, and
Rollup's build-start hook. It checks existing declaration bytes and modification
times, absent output directories, one warning per plugin instance, empty schema
metadata and field removal, explicit `types` overrides, and `types: false`.
The separate default Vitest suppression remains covered with injected context.
Explicit override cases cover both option forms with and without Vitest, plus
one runtime-only case per host instead of a redundant full cross-product.
The fixture clears inherited public test fields to keep empty-schema checks
independent of the caller's environment.
`typegen/prepare-types.test.ts` covers multi-product merge and scope preparation.
`typegen/shared-contract.test.ts` covers shared-contract lifecycle, dev/build
contexts, contention, and active-product runtime isolation, including a real Vite
dev server (POSIX only) and electron-vite scope builds. Electron bundles are
checked without launching Electron; these tests do not replace app acceptance.
`typegen/coordination.test.ts` covers lock waiting, cancellation, and owner recovery;
`execution/prepare.test.ts` covers cancellation of in-flight preparation on service
failure. Package consumers verify installed adapters and Electron preparation.

## Runtime conformance tests

Add syntax cases to `helpers/runtime-fixtures.ts`, not a separate host-specific
regression test. The same corpus runs through the raw shared transform and the
Vite, Rollup, esbuild and Webpack adapters. Generated wrapper combinations have
bounded depth; historical failing programs remain explicit fixtures.
Receiver-position cases also place wrappers around the root and intermediate
objects, checking shadowed writes and computed-key effects. Write operations
rotate across these cases rather than multiplying every syntax combination.

- Read cases declare a value, optional error name and ordered side effects.
  Both a reference build and an optimized build must match that expectation.
- Direct-write cases must fail with Matrix's read-only diagnostic. A parser or
  type error is not an acceptable substitute. Indirect mutation is a read-case
  runtime observation against the frozen snapshot.
- DCE cases additionally require removal of the exclusive development chunk.

The reference module is independent of Matrix's serializer and transform.
Reference builds disable tree shaking where configured by the harness, to avoid
using the host optimizer as the semantic oracle. Outputs execute as real modules
in isolated Node processes, including asynchronous chunks; observations preserve
`undefined`, negative zero and exceptions.

Rollup and Webpack use real esbuild-based TS/JSX transpilation. These builds do
not typecheck fixtures. The shared-transform path runs before type erasure, so
upstream transpilation cannot conceal a missing TS syntax guard.

`runtime/runtime-build.test.ts` reuses a small behavioral fixture across
development ESM, production/development CJS, disabled inlining and minification.
It checks branching, dynamic reads, indirect mutation and ordered effects.
Rollup has no minifier in this harness; esbuild CJS bundles dynamic imports
without splitting. Scoped builds separately require DCE, isolation and the
read-only diagnostic for aliased imports, not merely correct runtime values.
The full syntax corpus stays production ESM; these modes are representative
compatibility checks, not a Cartesian product with the corpus.

Keep loader ownership, resource types, source maps, Vue SFC and Electron tests
separate: these are host integration contracts, not interchangeable syntax cases.
This corpus is bounded coverage, not an exhaustive proof for all syntax or host
versions.

Run the matrix with:

```sh
mise exec -- pnpm test test/runtime/runtime-conformance.test.ts test/runtime/runtime-build.test.ts
```
