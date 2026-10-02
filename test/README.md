# Runtime conformance tests

Add syntax cases to `helpers/runtime-fixtures.ts`, not a separate host-specific
regression test. The same corpus runs through the raw shared transform and the
Vite, Rollup, esbuild and Webpack adapters. Generated wrapper combinations have
bounded depth; historical failing programs remain explicit fixtures.

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

Keep loader ownership, resource types, source maps, Vue SFC and Electron tests
separate: these are host integration contracts, not interchangeable syntax cases.
This corpus is bounded coverage, not an exhaustive proof for all syntax or host
versions.

Run the matrix with:

```sh
mise exec -- pnpm test test/runtime-conformance.test.ts test/runtime-build.test.ts
```
