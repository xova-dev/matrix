# @xova/matrix

Configuration-driven CLI for running and packaging multi-app workspaces.

English · [简体中文](README.zh-CN.md)

Define projects once, then run development, builds, previews, and custom commands by product and environment.

## Features

- Typed configuration for projects, products, variants, and targets
- Built-in `dev`, `build`, `dist`, `preview`, and `test` targets
- Target dependencies with `ready` and `completed` conditions
- `development`, `staging`, and `production` environments
- Custom environment names such as `qa` and `uat`
- Layered environment variables with dotenv and shell overrides
- Interactive product and environment selection
- Ordered target commands and configurable artifact materialization under `artifacts`

## Install

<!-- #region installation -->

Requires Node.js `>=22.18.0`.

```bash
pnpm add -D @xova/matrix
```

<!-- #endregion installation -->

Minimal Linux images also need the system `ps` command; see [process shutdown](docs/site/en/guides/execution.md#process-shutdown) for platform requirements.

## Quick start

<!-- #region quick-start -->

Create `matrix.config.ts` in the workspace root:

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: 'vite',
        build: { command: 'vite build', artifacts: { mode: 'archive' } },
        preview: 'vite preview',
      },
    },
  },
  products: {
    app: {
      version: '1.0.0',
      variants: { web: 'web' },
    },
  },
})
```

Run it from the directory containing the config file:

```bash
pnpm exec matrix dev app
pnpm exec matrix build app --env staging
pnpm exec matrix plan app --target preview --env production
pnpm exec matrix doctor
```

This assumes the Web project already has Vite installed and builds independently. An explicit product version avoids relying on the project's package version for archives; `archive` retains Web output for preview. `dev` is continuous: stop it with `Ctrl+C` before running another command. Run `pnpm exec matrix` for the interactive wizard; complete commands execute directly.

<!-- #endregion quick-start -->

## Documentation

The [documentation guide](docs/site/en/index.md) provides topic-based reading paths and a complete reference:

- [Core concepts](docs/site/en/concepts.md): projects, products, variants, and targets.
- [Configuration reference](docs/site/en/reference/configuration.md): fields, defaults, overrides, readiness, dependencies, identity, and versions.
- [Environments and schemas](docs/site/en/guides/environments.md): precedence, dotenv, and typed public values.
- [Build tool integration](docs/site/en/guides/integrations.md): Vite/Rollup/Webpack/esbuild, runtime snapshots, Electron scopes, and types.
- [Plugin and runtime reference](docs/site/en/reference/plugins.md): adapter options and public runtime fields.
- [Execution and artifacts](docs/site/en/guides/execution.md): target defaults, preparation, shutdown, and delivery.
- [CLI reference](docs/site/en/reference/cli.md) and [troubleshooting](docs/site/en/guides/troubleshooting.md).

## Examples

- [basic](examples/basic/README.md): framework-free introduction to two-project development and builds.
- [electron-web](examples/electron-web/README.md): two Web products sharing a real Electron project.
- [Example setup and verification boundaries](examples/README.md).

## Boundaries

- Matrix orchestrates your project commands; it does not install application frameworks or supply missing targets.
- The virtual runtime is an immutable build-time snapshot, not deployment-time configuration.
- `matrix plan` may contain sensitive values; review output before sharing it publicly.

## Development

See [development and verification](docs/site/en/contributing.md) for repository setup, checks, CI, and acceptance boundaries.

## License

[MIT](LICENSE)
