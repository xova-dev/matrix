# Examples

For concepts and configuration fields, see the [documentation guide](../docs/site/en/index.md) ([简体中文](../docs/site/zh-CN/index.md)). This directory keeps runnable setup and acceptance instructions alongside each example.

| Example                                | Purpose                        | Main features                                                                          |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| [basic](basic/README.md)               | Framework-free introduction    | Projects, products, variants, environment overrides, target dependencies and artifacts |
| [electron-web](electron-web/README.md) | Real multi-product integration | Two Vite pages, shared Electron, scoped runtime types, preparation and packaging       |

## Workspace development

From the repository root, using the Node and pnpm versions in `mise.toml`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check:examples
```

Both examples declare `@xova/matrix: workspace:*` and use the public package
entrypoints and CLI. Rebuild Matrix after changing its source; neither example
uses a source alias. The root lockfile covers both examples. Electron keeps its
own framework versions and downloads its binary only during explicit preparation.

For the interactive basic example:

```sh
pnpm example:basic
```

For Electron, prepare first, then start one product:

```sh
pnpm example:electron-web
pnpm --filter matrix-electron-web-example run dev:alpha
```

Stop development servers with `Ctrl+C`. Follow each example's README for builds
and non-interactive commands. Do not recursively run every workspace build or test:
the Electron acceptance flow is intentionally explicit.

## Configuration conventions

Use `matrix.config.ts` and `defineMatrixConfig` from `@xova/matrix`. Projects
declare directories and commands; products declare identity, environment values
and variants; variants add only necessary overrides and dependencies. Prefer
string shorthand for a single command or a variant without overrides.

Keep shared values in root `env` or schema defaults, product differences in
product `env`, and environment differences in `$env: defineMatrixEnv(...)`.
The two Electron products are explicit so their differences are visible without
following a configuration factory. Example URLs are public dummy data, not secrets.

## Verification boundaries

- `pnpm check:examples` checks both Matrix TS configurations, without starting
  applications or downloading Electron.
- Basic `test` checks injected context; its ordered Desktop build also checks
  its own output and the dependent Web output. Web preview serves the built file.
- Electron `check:types` additionally checks main/preload against generated
  declarations after preparation. The electron-vite host config is exercised by
  real builds, not by this standalone config typecheck: the workspace intentionally
  contains both Vite 7 and Vite 8 host types.
- `pnpm test:pack` verifies the published package surface and CLI shutdown.
- `pnpm test:electron-web` installs the current tarball outside the workspace
  and runs real development/build/startup acceptance. Registry versions and
  integrity records are projected from the root lockfile, then installed with
  `--frozen-lockfile`; only the Matrix workspace link becomes the tarball.

The exact `semver@5.7.2` and `semver@6.3.1` trust-policy exceptions preserve
dependencies from the former Electron npm lockfile. They do not exempt all semver
versions; remove them when those old versions leave the dependency graph.

Adapter syntax conformance remains in `test/`; examples are not another copy of
the complete adapter test matrix. Local success does not establish cross-platform
acceptance, interactive TTY usability, signing or installer behavior.
