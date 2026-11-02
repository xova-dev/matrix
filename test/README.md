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
settings. The package smoke runner selects profiles from this file; the
on-demand Electron example retains its own lockfile-pinned dependencies.

### CI environments

The [CI workflow](../.github/workflows/ci.yml) runs independent code/docs jobs on one source SHA. The docs job always checks/builds a read-only artifact; the code job retains these checks for code changes:

| OS      | Node    | Checks                                                            |
| ------- | ------- | ----------------------------------------------------------------- |
| Ubuntu  | 24.x    | Complete Vitest suite and full packed host compatibility          |
| Ubuntu  | 22.18.0 | Complete Vitest suite and platform packed smoke at the Node floor |
| Windows | 24.x    | Complete Vitest suite and platform packed CLI/Vite smoke          |

Documentation-only changes run lint, product wiring checks and relevant
site checks. Commit titles never skip CI or documentation builds. Manual CI always
runs code checks; `full` expands all host pins and Nuxt scenarios on these three managed combinations. It does not add macOS or real Electron app jobs.

CI and Publish share `checks.yml` rather than duplicate product responsibilities. Publish first queries successful complete CI at the exact native SHA, including all three required Linux/Windows compatibility jobs. Without qualifying evidence it runs the complete product workflow before calling shared release orchestration. Missing or documentation-only CI, query failure and timeout require source-check fallback; fatal lookup inputs block publication. Complete fallback must succeed and return the native SHA. Necessary code, release notes and migration files are allowed; no version-only commit or parent-CI exception remains.

Standard CI and Publish fallback use Ubuntu / Node 24's full profile plus platform smoke on the other two combinations. Both standard and manually expanded successful CI remain eligible for exact-SHA reuse. Linux owns host-version integration; Windows owns platform contracts rather than repeating Nuxt SSR products or Electron packaging. macOS has no default hosted evidence: removing its jobs does not establish platform equivalence or change runtime support. Run checks on macOS when that platform needs acceptance. Real Electron application acceptance is on demand, not a CI/publication prerequisite.

The shared flow checks the native candidate, builds documentation, runs `pnpm build` after complete product checks on that SHA, packs with pnpm lifecycle scripts disabled and tests that same TARBALL using the daily profile before publication. It does not repeat lint/types/examples in the publishing job. Provider policy runs inside the configured environment/concurrency gate. Publish/recovery read identical settings from `.github/xova.json`; manual Publish does not deploy.

`docs-recover.yml` is one shared recovery call. Operators confirm the published SHA and select its release tag. Shared source validation runs before rebuilding or waiting for deployment approval. Recovery creates a new artifact and never invokes npm publication.

Native release-it uses the pinned preparation preset in `.release-it.json`. Preview with an explicit version and `--dry-run`; the preset disables Git delivery and publication. The official plugin may stage a newly created changelog. Preserve partial preparation results on failure.

`test/scripts/release-workflows.test.js` checks only Matrix matrices, CI-reuse/fallback wiring and `.github/xova.json` settings. Explicit local toolkit binding also validates that configuration with the shipped parser for all five tasks and compares Publish to the pinned toolkit example. Shared calls use configuration defaults without command/setup overrides; the separate query job alone adds actions:read and tolerates recoverable failures. Fatal input reporting, complete product checks and publication remain blocking. Check/build grants remain read-only and recovery keeps the Pages permission boundary. Generic runners, fake publishers and upstream fixture tests stay in Xova Actions. Shared quality checks run product wiring tests for both code and documentation-only changes. Code uses `release:check`; the docs-only path runs lint. Quality success gates the product matrices; final publication never uses docs-only optimization.

All shared workflow and action calls pin the same full toolkit SHA whose remote CI has passed. Normal `mise exec -- pnpm check` needs no local toolkit binding. Optionally use `XOVA_ACTIONS_ROOT=../actions mise exec -- pnpm check` with that toolkit revision to validate the actual workflow/action contracts and configuration parser as well. Binding verification rejects a different HEAD or modified tracked files/index before reading contracts. Preparation remains independently pinned. Local fixtures and toolkit CI do not prove nested required-check names, Matrix-hosted execution, OIDC or deployment acceptance.

Every package profile includes the host-free CLI consumer. Full/daily include
all three electron-vite type-preparation combinations, without launching Electron.
The packaged POSIX process-group shutdown fixture runs on Linux and local macOS;
its Windows skip is unchanged. Windows instead runs real cancellation, process-tree
teardown, junction/cwd and side-effect regressions in the complete Vitest suite.
The separate Node 24 quality job runs lint, typecheck, build and example checks.
Compatibility jobs include the lockfile and compatibility manifest in their
cache keys. Shared setup selects only pnpm from setup.cache and documentation inherits it; cache paths and lock patterns are owned by the shared toolkit. Full host verification runs on Ubuntu / Node 24 for every code change.
Compatibility jobs also cache npm's download store for the CLI consumer.
These caches use OS / architecture and dependency-manifest keys, with same-platform
fallbacks. Installation, checksum validation, builds, and tests still run on cache
hits. Consumer directories, node_modules, and build outputs are not cached.

Compatibility steps set TMPDIR/TEMP/TMP to runner.temp so Windows temporary consumers stay on the checkout volume and reuse its pnpm store. CLI and Vite consumers use paths containing spaces. Workflow wiring tests execute Node's real temporary-directory selection with conflicting system defaults. Local checks do not establish Windows cache transport or download counts; those require a hosted Windows run. Shared quality checks do not select npm caching because they run pnpm commands; actual npm consumers retain their product-owned download cache.

Quality and compatibility jobs install the workspace, including example type/config checks but not real app startup. The existing on-demand `pnpm test:electron-web` command still packs the current source and installs the example's complete locked dependencies in a separate consumer before preparation, both development runs and all three packaged application runs. No default job or release fallback runs that command.

Vitest retains its default worker concurrency and per-file isolation. Compare the same heavy files with `pnpm exec vitest run <files> --isolate`, then repeat with `--maxWorkers 2` or `--maxWorkers 1` in alternating order. Keep the pool, test cases and dependencies unchanged and run comparisons sequentially. Lower concurrency must show a repeatable benefit on the target runner before adoption; local macOS timings do not establish hosted performance.

### Package profiles

All profiles select versions from the same exact-version manifest:

| Profile  | Vite                                | Rollup                              | Webpack                | esbuild                                                | Electron combinations | Total consumers |
| -------- | ----------------------------------- | ----------------------------------- | ---------------------- | ------------------------------------------------------ | --------------------- | --------------- |
| daily    | Each major's first and last pin (8) | Each major's first and last pin (6) | First and last pin (2) | Last pin of each retained minor plus support floor (4) | 3                     | 23              |
| platform | Latest pinned Vite (1)              | —                                   | —                      | —                                                      | —                     | 1               |
| full     | 8                                   | 6                                   | 2                      | 6                                                      | 3                     | 25              |

Counts exclude the shared CLI-only consumer and, for full/daily, the two Nuxt consumers (native and mixed checks share each installation). Platform installs no Nuxt or Electron consumer. Native Vite checks reuse each Vite consumer's installation. First/last refer to the pinned
manifest, not a dynamically fetched registry version. Support ranges do not
change with the selected profile. Vite 8 consumers explicitly install the WASM
runtime peers pinned in the manifest, with strict peer checks still enabled.
The host workspace pins `schema-utils` to `4.5.0`, the version in the repository
lockfile, through `hostWorkspaceOverrides`. This keeps historical Webpack fixtures
reproducible after `schema-utils@4.8.1` added a `webpack ^5.112.0` peer. Strict peer
checks remain enabled; published dependencies and host support ranges do not change.

The manifest is a representative sample, not an exhaustive list of supported
releases. Vite and Rollup retain the lowest and highest previously verified pin
of each supported major; Webpack retains its support floor and highest verified
pin. esbuild retains its support floor and highest verified pin plus two API
boundary pairs used by Matrix's loader-ownership guards:

- `0.14.0` / `0.14.54` straddle the introduction of `onLoad`'s `suffix` field in
  [esbuild 0.14.3](https://github.com/evanw/esbuild/blob/main/CHANGELOG-2021.md#0143).
- `0.19.0` / `0.19.12` straddle the introduction of `onLoad`'s `with` import
  attributes in
  [esbuild 0.19.7](https://github.com/evanw/esbuild/blob/main/CHANGELOG-2023.md#0197).

These are existing verified pins on either side, not the exact API-introduction
versions or an evenly spaced sample. The guards tolerate absent fields on old
hosts. Matrix and its installed Unplugin adapter use the ordinary build/plugin
API; esbuild's context API is not an additional sampling boundary for this runner.
Every selected Vite/Rollup/Webpack/esbuild pin keeps the same typecheck and behavioral checks. Host sampling
does not change a support range. `full` runs every retained pin and all three electron-vite combinations; `daily` keeps its existing selection rule and both Nuxt endpoints.
`platform` is an installed-package contract smoke, not another host-version matrix:
it reuses the latest pinned Vite fixture for preparation, strict types, dev transforms,
builds, native integration and config selection, alongside the host-free CLI's
exports/config/preparation/doctor checks.
The CLI consumer also retains its existing packed Webpack-loader smoke against
the repository's Webpack; it does not install Webpack into the host-free consumer.

- Ubuntu / Node 24: `pnpm test:pack`; Ubuntu / Node 22 and Windows / Node 24: `pnpm test:pack --profile platform`.
- Exact-tarball publication verification and intermediate local host checks: `pnpm test:pack --profile daily`.
- Full local verification: `pnpm test:pack` (defaults to `full`).
- Expanded CI verification: manually dispatch CI with `full` enabled on the same three managed combinations; macOS and Electron app acceptance remain on demand.

Both Nuxt endpoints run in full/daily. `full` runs the complete suite; `daily` retains the reduced suite selected in `pack-matrix.mjs`. Platform does not install Nuxt:

| Nuxt coverage          | Full and daily                                                                                                                                                                  | Additional checks in `full`                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main chain             | Native/typegen-disabled commands; mixed prepare/declarations; strict Matrix contract typecheck; dev; two product SSR builds; client assets; immutable Node deployment overrides | Nuxt application and independent SPA application typechecks                                                                                      |
| Config/Layer selection | Explicit same-directory, outside-root and directory-junction paths; local/package/remote Layers; native extensionless acceptance/rejection control                              | Default discovery with `.ts`/`.mjs` root/Layer permutations                                                                                      |
| Failures               | Each selected Layer path preserves declarations on load failure; remote-fetch failure at the first selected path                                                                | Collision collection, duplicate plugin, typegen/runtime options, client/server divergence, unsupported Nitro/environment API and missing context |

All CI compatibility jobs still run the entire Vitest suite, including invalid/junction cwd, Nuxt collection lifecycle, HTTP/process-tree cleanup and cancellation/service-abort regressions. The packaged POSIX CLI shutdown fixture remains active where supported; real Nuxt server cleanup runs with full/daily, not platform. Full-only option/permutation checks remain part of Ubuntu / Node 24's standard job; reduced profiles are not a reduced support claim.

The required Ubuntu / Node 24 job runs full in CI or Publish fallback; qualified exact-SHA reuse avoids repeating it. Consumers run with concurrency 2;
`--concurrency 1` runs serially and values up to 4 are supported. Each consumer's
prepare, typecheck, and build phases remain sequential. Failures are collected
before removing temporary workspaces. Logs record install, prepare, typecheck,
and build durations, followed by elapsed wall time and the five slowest
consumers. Phase totals are cumulative and can exceed wall time under concurrency.
Nuxt additionally records inclusive wall spans for the whole Nuxt suite and
each endpoint (including installation and remote Layer server cleanup), plus
Matrix dev and each Node deployment's startup, HTTP verification, shutdown and
complete lifecycle. Forced cleanup gets its own span when needed. These nested
wall spans are reported separately and never added to command phase totals,
slowest-consumer rankings or command outcome counts; do not sum them.
Vite and Nuxt share fixture file/output helpers and failure diagnostics in
`scripts/pack-fixtures.mjs`. Expected rejections must retain a nonzero process
exit code and match the asserted diagnostic before timings label them
`expected rejection`; timeout, cancellation, signal, buffer, and other execution
errors remain failures even if a handler exits with code zero or an expected diagnostic.
Outcome totals distinguish expected rejections from actual failures.
`test/scripts/pack-timings.test.js` uses real Node subprocesses to cover both native-loader
outcomes, unexpected success, wrong diagnostics, and non-process failures, plus
timeouts and graceful cancellation with zero and nonzero handler exits.
It also checks nested wall-span accounting and cleanup-error propagation.
SIGTERM timeout-handler cases run on POSIX; IPC graceful-cancellation cases also run on Windows.

`scripts/pack-smoke.mjs` owns candidate selection, the single pack, isolated CLI
installation, host orchestration, and final cleanup. `scripts/pack-cli.mjs` owns
host-free CLI checks and the unchanged POSIX process-group shutdown fixture.
`scripts/pack-nuxt.mjs` installs each endpoint once and groups native commands,
mixed integration, and their shared HTTP server/immutable Node-output checks
as internal functions. `pack-nuxt-layers.mjs` supplies the controlled remote Layer
to the mixed production chain and owns lightweight config-selection checks.
CLI shutdown and IPC preparation retain their separate lifecycle contracts.

### Published-package hosts

`pnpm test:pack` consumes an absolute `TARBALL` when supplied, otherwise packs Matrix once, then installs the tarball into temporary
consumers. The publication workflow supplies the already packed candidate and runs the daily profile; it never repacks during that check. Host versions coexist in pnpm workspaces with automatic peer
installation and workspace-root peer resolution disabled.

| Host    | Version lines                                               | Pinned versions | Runner                   |
| ------- | ----------------------------------------------------------- | --------------: | ------------------------ |
| Vite    | 5.1.0 / 5.4.21; 6.0.0 / 6.4.4; 7.0.0 / 7.3.7; 8.0.0 / 8.3.3 |               8 | `scripts/pack-vite.mjs`  |
| Rollup  | 2.68.0 / 2.79.2; 3.0.0 / 3.29.5; 4.0.0 / 4.64.1             |               6 | `scripts/pack-hosts.mjs` |
| Webpack | 5.100.1 / 5.111.1                                           |               2 | `scripts/pack-hosts.mjs` |
| esbuild | 0.12.0; 0.14.0 / 0.14.54; 0.19.0 / 0.19.12; 0.28.2          |               6 | `scripts/pack-hosts.mjs` |

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
`skipLibCheck: false`. A separate CLI-only consumer installs none of the five
hosts and verifies exports, configuration isolation, preparation, doctor, and
process shutdown.

### Native host integration

`scripts/pack-nuxt.mjs` runs one mixed SSR/Layer production chain per Nuxt endpoint (4.0.3 and 4.6.3). It covers repeated Layer/application Module registration, custom `srcDir`, scope/output, cross-product optional declarations, late Nuxt hooks and two product builds. Alpha uses generated types; Beta explicitly combines `project.typegen: false` with Module `types: false`, retaining the shared prepared contract. Both builds include local, installed-package and controlled HTTP remote Layers, and verify emitted Layer values and product/private isolation. Actual client/server Vite pipelines must expose identical snapshots/prefixes; value/prefix divergence still needs real build rejection. Preparation remains config-only, without compiling the app or starting a Vite server.

The main fixture explicitly declares its application `rootDir`. A standalone native reproduction with a `.ts` root config, custom `srcDir` and object-exported HTTP Layer observed Nuxt 4.0.3 change the default `rootDir` to its remote cache on repeated same-process `loadNuxt` calls, even with `ready: false` and no Matrix Module. Nuxt 4.6.3 retained the application root in that reproduction. This suite verifies the explicit-root combination; it does not certify the affected default-root combination or fix upstream config caching.

The same installation retains an independent `ssr: false` custom-prefix application's declaration preparation in full/daily, and its Nuxt typecheck in `full`, not a second static production build. Native no-Module/typegen-disabled integration runs Matrix preparation and a native `nuxt prepare` target: filesystem markers prove Matrix does not evaluate its host, while Nuxt owns its generated types and receives the product environment. Native SPA generation and a separate native SSR build are not repeated; the mixed chain owns runtimeConfig coexistence, public/private output and immutable Node deployment coverage.

Config selection covers `.ts` application / `.mjs` Layer and the reverse, nested `.cts` Layers, a file-installed package Layer (`.mts`), and Nuxt's real remote loader. Explicit same-directory, outside-root and directory-symlink selection preserve exact root selection. Each case uses one Matrix target: automatic preparation supplies the contract and Matrix environment before loading/readying real Nuxt through native discovery. The resulting custom-prefix/schema/Layer declarations form the baseline for subsequent Layer-load and remote-fetch failures, which must preserve it. There is no additional standalone prepare or production build for each suffix/path. The isolated fixture declares `giget`; no global tool or public service is used. These HTTP checks do not certify external authentication or network behavior.

An explicit extensionless `nuxt.config` omits `configHost` and is compared with native Nuxt loading. Native loader rejection remains an error rather than a generic fallback; accepted files use one automatically prepared Matrix target and real Nuxt load/readiness, without another production build.

`scripts/pack-vite.mjs` also checks real Vite/electron-vite config selection: six native JS/TS extensions, explicit custom names, and extensionless-file acceptance/rejection against each tested native resolver at representative supported versions. Only unrecognized names declare `configHost`; standard names, including explicit extensionless paths, infer the host. Extensionless files do not join automatic discovery or change priority/ambiguity handling. Supported config selection checks perform both preparation and actual host builds, separate from real Electron-window acceptance.

The Nuxt-only default `['VITE_', 'NUXT_PUBLIC_']` is checked with typed schema values, raw string env reads, and shared Vite business variables in real consumers. An explicit single-prefix application excludes both defaults, and Matrix does not synthesize native runtimeConfig fields. `runtime/snapshot.test.ts` checks equal/unequal and camelCase aliases against complete diagnostics. `typegen/typegen.test.ts` composes the real merge/render/generator with filesystem declarations for those aliases plus cross-product and schema-only collisions, including reverse cross-product ordering, value-free diagnostics and preservation of an existing declaration. No Nuxt/Vite framework is mocked for these shared rules.

Full-profile collision-collection rejections retain both products on the main
application, but temporarily exclude the unrelated custom-prefix SPA. Each
case restores the complete project/product configuration before subsequent
checks. Both applications and products remain in normal shared preparation;
the collision diagnostics, private-value exclusion and valid-declaration
preservation assertions are unchanged.

In `full`, both Nuxt endpoints retain a real unequal-alias preparation rejection to verify strict collection wiring. The 4.0.3 consumer additionally checks cross-product collection/merging; 4.6.3 checks schema-only collection. These paths use the same Matrix merge/generator tested above, so repeating every input permutation on both host versions is unnecessary. Each retained package rejection still checks both diagnostic keys, excludes collision values and preserves valid declarations. Full runtime-only builds independently reject aliases. Bare Vite defaults and legacy untyped collisions remain covered for other adapters.

The mixed production chain includes the default Nitro Node server: `server/api` and Nitro plugins directly import the scoped virtual module and reuse the app snapshot. A real development run verifies the snapshot is initialized before Nitro handles requests. Each emitted product artifact starts directly with Node, twice with different deployment env, without Matrix context. SSR HTML, client assets, API responses and a Nitro-plugin response header verify selected-product values, public/private separation, immutable build snapshots and independent native runtimeConfig overrides. Other Nitro presets reject direct Matrix imports; a Cloudflare negative fixture checks the diagnostic, not Cloudflare deployment support. SPA generation without direct Nitro imports remains supported.

Nuxt application typecheck retains Nuxt's generated compiler settings; a separate Matrix contract consumer uses `strict: true` and `skipLibCheck: false`, checking optional fields, scalar types, private-field exclusion and immutability. Forcing `skipLibCheck: false` fails on Nuxt 4.0.3's own ambient declarations; this does not relax the separate Matrix contract check. Existing duplicate installation, missing context, runtime-only and unsupported-builder/environment-API boundaries remain covered. `test/typegen/nuxt-preparation.test.ts` exercises complete hook dispatch, single cleanup after readiness/config failure, original-plus-close diagnostics, and bounded IPC cancellation including hung cleanup, without relying on OS signal handlers.

Every Vite pin also runs an isolated native consumer with `project.typegen: false`,
no Matrix plugin, virtual module, or declarations. It compiles using Vite's
`vite/client` types, builds two products, executes the emitted modules, and
checks public/private isolation. Real host-config filesystem side effects prove
that explicit prepare and automatic collection do not load the host before the
native build command. Existing enhanced fixtures run unchanged before this path.

Full/daily retain both Nuxt endpoints: 4.0.3 (the tested lower
bound) and 4.6.3 (a representative later minor), with exact pins and vue-tsc in
`compatibility-matrix.json`. The historical 4.0.3 fixture pins its compatible
`@nuxt/cli` to 3.27.0 instead of installing the later CLI's incompatible schema
peer; strict peer checks remain enabled. Nuxt fixtures also install the manifest's
WASM runtime peers. These are test-only settings, not published dependency overrides.
These exact test pins are within the optional Nuxt peer range and do not certify every intervening minor or Nitro preset. The mixed chain keeps native runtimeConfig fields alongside Matrix's immutable snapshot. Each product's identical Node artifact starts twice without Matrix context, consumes distinct deployment `NUXT_PUBLIC_NATIVE_API` and private-token overrides, and retains its file fingerprint. SSR HTML, every referenced client asset, API responses and the Nitro-plugin header must deliver the product snapshot without private/internal fields. Runtime-only, missing-context, duplicate-plugin, collision, unsupported preset and environment-API guards retain their meaningful real-process regressions; Vite/Nitro-only failures still execute builds where preparation cannot detect them.

The automated package suite inspects HTTP/SSR responses and client assets. It is not browser hydration/interaction/navigation acceptance; run those separately against the emitted Node server. The reduced suite does not repeatedly certify static SPA generation. Nuxt application typechecks retain Nuxt's generated compiler settings, not the Matrix contract consumer's independent `skipLibCheck: false` baseline.

Nuxt HTTP-service acceptance logs separate bounded startup, verification and shutdown stages. Each HTTP request, including response-body consumption, has its own deadline. Teardown targets only the launched process tree: POSIX uses its owned process group and SIGTERM; Windows explicitly uses `taskkill /T /F` as resource cleanup, not graceful Matrix cancellation. A failed request, unsuccessful POSIX exit or shutdown timeout remains a failure even if forced cleanup succeeds; original and cleanup errors are retained with a bounded raw service-output tail. `scripts/pack-nuxt-server.test.js` uses real subprocesses to cover normal HTTP/exit, hung readiness, headers/body waits, inherited descendant pipes, unsuccessful POSIX exits, diagnostics and OS-denied cleanup. The independent CLI cancellation regressions retain their own contract.

Process fixtures await their original runner/worker/subprocess completion before temporary-directory cleanup; PID disappearance alone does not prove inherited streams and OS handles have closed. Nuxt server tests have one fallback owner that settles actual subprocesses in `afterEach`, before the shared temporary-directory helper removes files with bounded filesystem retries; persistent cleanup failures still fail the test. Windows tree-command error propagation is tested at its OS-command boundary without changing the running process's platform; native service tests retain each platform's actual teardown. The POSIX packaged CLI fixture retains verification and cleanup errors together, and still waits for close if process-group signaling fails.

`typegen/ownership.test.ts` additionally covers `typegen: false` with equal,
ancestor, and nested roots: no host evaluation or generic fallback, no re-entry
through overlapping-project expansion, no native-product keys in enhanced
contracts, and unchanged project preparation commands. `execution/doctor.test.ts`
covers skipping native host discovery while retaining ordinary filesystem checks.
An unselected native project's dangling root also stays outside mixed type-output
ownership resolution, so it cannot block another project's prepare/build. `execution/exec.test.ts` checks missing/dangling-junction/file working directories before real shell commands, including preparation failures and no command side effects. A preceding command may still create a later task/preparation directory: validation follows actual startup, not a plan-wide preflight.
An explicitly gated filesystem check also verifies SIGINT/SIGTERM cancellation and service-failure abort before command startup, with real child commands, side-effect checks, cancellation reports and restored signal listeners.

### Electron combinations

Full/daily run these three combinations with Electron 44.4.5 and
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
run is on demand, not repeated for every package-matrix combination or required by default CI/publication.

`scripts/electron-report.test.js` covers missing, malformed, and incorrect
acceptance reports after a successful command exit, including captured stdout
and stderr, product/environment/phase context, exit status, and the quiet success
path. It uses real Node subprocesses and report files; these diagnostics tests
do not replace real Electron application acceptance when that example needs verification.

### Updating the matrix

Change exact test pins and shared settings in
`scripts/compatibility-matrix.json`. Update `package.json` only when changing
the supported ranges. Keep this matrix and both integration guides aligned,
then run `pnpm check` and `pnpm test:pack`. Change OS/Node jobs once in
`.github/workflows/checks.yml`; CI and Publish both call that product workflow.

## Automatic declaration safeguards

`execution/doctor.test.ts` covers filesystem-only host config validation, invalid
explicit paths, ambiguous discovery, selection priority, and host-free projects.
`typegen/prepare-types.test.ts` groups discovery by host: all six JS/TS extensions,
explicit-only extensionless selection, unrecognized names, host conflicts,
ambiguity, root-only discovery and Nuxt/electron-vite/Vite priority.
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
