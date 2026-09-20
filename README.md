# @xova/matrix

Configuration-driven CLI for running and packaging multi-app workspaces.

English · [简体中文](README.zh-CN.md)

Define projects once, then run development, builds, previews, and custom commands by product and environment.

## Features

- Typed configuration for projects, products, variants, and targets
- Built-in `dev`, `build`, and `preview` targets
- Target dependencies with `ready` and `completed` conditions
- `development`, `staging`, and `production` environments
- Custom environment names such as `qa` and `uat`
- Layered environment variables with dotenv and shell overrides
- Interactive product and environment selection
- Optional build archives under `artifacts`

## Install

Requires Node.js `>=22.18.0`.

```bash
pnpm add -D @xova/matrix
```

## Quick start

Create `matrix.config.ts` in the workspace root:

```ts
import { defineMatrixConfig, defineMatrixEnv } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: 'vite',
        build: { command: 'vite build', archive: true },
        preview: 'vite preview',
      },
    },
  },
  products: {
    app: {
      variants: { web: 'web' },
    },
  },
})
```

Run it from the directory containing the config file:

```bash
matrix dev app
matrix build app --env staging
matrix plan app --target preview --env production
matrix doctor
```

When `product`, target, or `--env` is omitted in an interactive terminal, Matrix prompts for a selection. One interactive run selects a single Product.

See [`examples/basic`](examples/basic/README.md) for a self-contained example that runs without a framework dependency.

## Configuration

| Concept | Purpose                                                         |
| ------- | --------------------------------------------------------------- |
| Project | An application directory and its commands                       |
| Product | A runnable deliverable composed of variants                     |
| Variant | A product entry bound to a project                              |
| Target  | A command such as `dev`, `build`, `preview`, or a custom target |

### Multiple variants

A product can run more than one project and express dependencies per target:

```ts
export default {
  products: {
    app: {
      variants: {
        web: 'web',
        desktop: {
          project: 'desktop',
          targets: {
            dev: { dependsOn: [{ variant: 'web', condition: 'ready' }] },
            build: { dependsOn: [{ variant: 'web', condition: 'completed' }] },
          },
        },
      },
    },
  },
}
```

`ready` is useful for continuous targets such as `dev`; `completed` is useful for one-shot targets such as `build`.

### Environments

Use top-level `env` and `$env` for values shared by all products. Put product-specific values under the product when different products assemble the same projects with different backends:

```ts
export default defineMatrixConfig({
  projects: {},
  products: {
    app: {
      appId: 'com.example.app',
      env: { VITE_API_BASE: 'http://localhost:3000' },
      $env: defineMatrixEnv({
        staging: { VITE_API_BASE: 'https://staging-api.example.com' },
        production: { VITE_API_BASE: 'https://api.example.com' },
      }),
      variants: {},
    },
  },
})
```

`defineMatrixEnv()` is syntax sugar for the c12-compatible `$env.<environment>.env` shape. The raw shape remains supported.

Values are merged from low to high precedence:

```text
global env/$env < product env/$env < .env layers < process.env < MATRIX_*
```

Product-level environment values are resolved independently for each product. This lets two products reuse the same Desktop project while connecting it to different Web variants or services.

Custom environment names are supported. Define them with the same helper and pass the name explicitly to the CLI:

```ts
export default defineMatrixConfig({
  $env: defineMatrixEnv({
    qa: {
      VITE_API_BASE: 'https://qa-api.example.com',
    },
  }),
  projects: {},
  products: {},
})
```

```bash
matrix build app --env qa
matrix plan app --target preview --env qa
```

Custom environments are available through `--env`. When running interactively, Matrix adds names found in the top-level and product `$env` configuration to the selector.

Dotenv files are loaded as `.env`, `.env.local`, `.env.<environment>`, and `.env.<environment>.local`. Matrix passes variables such as `VITE_*` and `NUXT_*` to child processes; application frameworks keep ownership of their own runtime configuration.

## Targets and defaults

The built-in targets use these defaults:

| Target    | Environment   | Continuous |
| --------- | ------------- | ---------- |
| `dev`     | `development` | Yes        |
| `build`   | `production`  | No         |
| `preview` | `production`  | Yes        |

Custom targets are non-continuous by default and use `development` unless `--env` is provided. Project roots default to `.`, target output directories default to `dist`, and archive output defaults to `artifacts`. Archives are disabled by default, are only valid for the build target, and use zip when enabled. A configured archive fails the build when its output directory does not exist.

Interactive Target options are derived from the common targets available to the selected Product's Variants. Use `--variant` to narrow the execution scope before resolving Target availability.

Any configured target can be invoked from the CLI. `test`, `lint`, and `e2e` are common custom targets.

## Commands

```text
matrix [target] [product] [--variant name] [--env <environment>]
matrix dev [product]
matrix build [product] [--env <environment>] [--archive]
matrix preview [product] [--env <environment>]
matrix plan [product] [--target <target>] [--env <environment>]
matrix doctor
matrix <custom-target> [product] [--env <environment>]
```

## Development

Dependency versions are maintained in the pnpm catalog in `pnpm-workspace.yaml`.

```bash
pnpm install
pnpm check
pnpm lint:fix
```

`pnpm lint:fix` formats JavaScript, TypeScript, and Markdown through ESLint. `pnpm check` runs lint, typecheck, tests, and the production build.

## License

[MIT](LICENSE)
