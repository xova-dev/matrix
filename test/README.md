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
settings. Both package test runners read this file directly.

### CI environments

The [CI workflow](../.github/workflows/ci.yml) runs the following matrix:

| OS                     | Node    | Commands                                                |
| ---------------------- | ------- | ------------------------------------------------------- |
| Ubuntu, macOS, Windows | 22.18.0 | `pnpm test`, `pnpm test:pack`                           |
| Ubuntu, macOS, Windows | 24.x    | `pnpm test`, `pnpm test:pack`, `pnpm test:electron-web` |

Each row expands to three OS jobs. POSIX process-group shutdown assertions run
on Ubuntu and macOS; Windows runs the remaining checks. The separate Node 24
quality job runs lint, typecheck, build, and example checks.

### Published-package hosts

`pnpm test:pack` packs Matrix once, then installs the tarball into temporary
consumers. Host versions coexist in pnpm workspaces with automatic peer
installation and workspace-root peer resolution disabled.

| Host    | Version lines                                            | Pinned versions | Runner                   |
| ------- | -------------------------------------------------------- | --------------: | ------------------------ |
| Vite    | 5.1–5.4, 6.0–6.4, 7.0–7.3, 8.0–8.3                       |              34 | `scripts/pack-vite.mjs`  |
| Rollup  | 2.68, 2.70, 2.71, 2.79; 3.0, 3.29; 4.0, 4.38, 4.40, 4.64 |              10 | `scripts/pack-hosts.mjs` |
| Webpack | 5.100–5.111, starting at 5.100.1                         |              23 | `scripts/pack-hosts.mjs` |
| esbuild | 0.12–0.28                                                |              32 | `scripts/pack-hosts.mjs` |

Every pinned version runs its row's checks below. A dash means that the check
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

### Updating the matrix

Change exact test pins and shared settings in
`scripts/compatibility-matrix.json`. Update `package.json` only when changing
the supported ranges. Keep this matrix and both integration guides aligned,
then run `pnpm check` and `pnpm test:pack`. Change OS/Node jobs in
`.github/workflows/ci.yml`.

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
