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

Requires Node.js `>=22.18.0`.

Process-tree shutdown uses the system `ps` command on macOS/Linux (install `procps` in minimal Linux images) and `taskkill.exe` on Windows. POSIX tasks receive SIGTERM, followed by SIGKILL after 30 seconds if needed; Matrix waits for the controlled process group to stop, not just its shell.

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
        build: { command: 'vite build', artifacts: { mode: 'archive' } },
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

Run `matrix` for Product → Action → Configuration. Unique choices are selected automatically. The compact configuration menu shows the current variants and environment; run immediately, edit either field, view execution details, or return to the action list. Details include dependencies, Node mode, and the equivalent command. One run selects one product; adjustments are not remembered between runs.

In supported interactive terminals, the wizard uses a temporary alternate screen and replaces the previous page instead of accumulating selection history. Run, cancel, and error paths restore the original terminal; execution prints one final summary and leaves task logs on the normal screen. `ACCESSIBLE=1`, Clack accessibility settings, and `TERM=dumb` / `TERM=unknown` keep prompts on the normal screen without switching screens or clearing pages. Complete commands and non-interactive runs never enter the temporary screen.

Complete commands such as `matrix dev app` run immediately, even in a terminal: the environment defaults from the target and the scope defaults to all variants. Incomplete commands such as `matrix dev` or `matrix --product app` prompt only for missing product/action choices, then show the configuration menu. Outside a terminal or in CI, ambiguous product/action selections fail with guidance instead of prompting. Use `--product` and `--target` for explicit selections, `--help` for examples, and `--env=name` or repeated `--variant` / `-v` options when convenient.

See [`examples/basic`](examples/basic/README.md) for a self-contained example that runs without a framework dependency.

For CI detection, unset, empty, `false`, and `0` values allow interactive mode when both input and output are terminals. Values are trimmed and case-insensitive; other non-empty values disable prompts and temporary screens.

## Configuration

| Concept | Purpose                                                                 |
| ------- | ----------------------------------------------------------------------- |
| Project | An application directory and its commands                               |
| Product | A runnable deliverable composed of variants                             |
| Variant | A product entry bound to a project                                      |
| Target  | A command such as `dev`, `build`, `preview`, `test`, or a custom target |

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

Ordinary application variables are merged from low to high precedence:

```text
global env/$env < product env/$env < .env layers < process.env
```

Product identity overrides are resolved from the merged environment before suffixes are applied:

```text
product identity < variant identity < merged identity override < environment suffix
```

`MATRIX_PRODUCT_NAME`, `MATRIX_PRODUCT_SLUG`, and `MATRIX_PRODUCT_APP_ID` may provide identity overrides through the environment. The final values, including suffixes, are written back to both task metadata and the corresponding `MATRIX_PRODUCT_*` variables. `MATRIX_PRODUCT_ID`, `MATRIX_PRODUCT_KEY`, execution-context variables, and `NODE_ENV` are generated by Matrix and cannot be overridden by the environment.

Matrix injects the following execution-context variables into every child process:

```text
MATRIX_ENV_NAME
MATRIX_TARGET
MATRIX_PRODUCT_KEY
MATRIX_PRODUCT_ID
MATRIX_PRODUCT_NAME
MATRIX_PRODUCT_SLUG
MATRIX_PRODUCT_APP_ID
MATRIX_VARIANT
MATRIX_PROJECT
MATRIX_NODE_ENV
NODE_ENV
```

`MATRIX_ENV_NAME` is the selected Matrix configuration environment and may be a custom name such as `staging` or `qa`. `NODE_ENV` describes the target process mode: `dev` uses `development`, `test` uses `test`, while `build` and `preview` use `production`. `MATRIX_NODE_ENV` is the same generated value under the reserved `MATRIX_` prefix so Vite's prefixed `config.env` can carry it into the build-time runtime module. Therefore a staging build normally receives `MATRIX_ENV_NAME=staging`, `MATRIX_NODE_ENV=production`, and `NODE_ENV=production`. `MATRIX_PRODUCT_APP_ID` is emitted only when the resolved product identity has an `appId`; environment suffixes are applied before it is exported.

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

Configuration files can read the selected dotenv values through `process.env` during evaluation, with inherited Shell values taking precedence. Each configuration load or environment discovery runs in a short-lived Worker with its own environment and complete ESM/CommonJS module cache. Local configuration imports are evaluated together for that load; the host's environment and module caches are not modified. The Worker is terminated after returning the result, so configuration files should produce data rather than start persistent services. Execution plans retain a separate environment snapshot; returned `layers` are JSON diagnostic snapshots, not executable objects.

### Build tool integration

Matrix provides one Unplugin factory and host-specific entrypoints.

    import matrix from '@xova/matrix/vite'

    export default defineConfig({
      plugins: [matrix()],
    })

The Vite adapter preserves the resolved envPrefix and adds the reserved MATRIX_ prefix. It reads the final Vite config.env and exposes the structured build context through virtual:matrix/runtime:

    import { matrix } from 'virtual:matrix/runtime'

    matrix.environment
    matrix.product.name
    matrix.product.appId
    matrix.config.apiBase

    matrix.isDevelopment
    matrix.isProduction
    matrix.isTest

The mode flags are derived from Matrix's resolved `nodeEnv` (`development`, `production`, or `test`). They are build-time snapshot values; use `matrix.target` for Matrix-specific targets such as `dev`, `build`, `dist`, and `preview`.

The same factory is available from @xova/matrix/rollup, @xova/matrix/webpack, and @xova/matrix/esbuild. The virtual module is a build-time snapshot, not a deployment-time runtime configuration system. Only variables already exposed by the host prefixes are mapped into matrix.config.

For multiple Electron configs, assign a scope to each build so main, preload, and renderer do not overwrite one another:

```ts
export default defineConfig({
  main: {
    plugins: [matrix({ scope: 'main' })],
  },
  preload: {
    plugins: [matrix({ scope: 'preload' })],
  },
})
```

Import `virtual:matrix/runtime/main` and `virtual:matrix/runtime/preload` respectively. Their declarations are generated as `.matrix/types/matrix-runtime-main.d.ts` and `.matrix/types/matrix-runtime-preload.d.ts`.

Run `matrix prepare` to generate `.matrix/types/matrix-runtime.d.ts` under every project referenced by the selected products. When a project is shared by multiple products, its declaration contains the union of their public environment keys. It derives `ImportMetaEnv` and `matrix.config` key types from `VITE_*` (and other configured public prefixes) without writing environment values. Build plugins also generate the matching declaration after resolving the final `envPrefix` by default; in a Vitest environment they do not overwrite existing types by default, while `types: true` or `types: { output: '...' }` explicitly enables generation and `types: false` always disables it. Add `.matrix/types` to each project's `include` list in `tsconfig.json` to enable the declarations:

```json
{
  "include": ["src", ".matrix/types"]
}
```

## Targets and defaults

The built-in targets use these defaults:

| Target    | Environment   | Continuous |
| --------- | ------------- | ---------- |
| `dev`     | `development` | Yes        |
| `build`   | `production`  | No         |
| `dist`    | `production`  | No         |
| `preview` | `production`  | Yes        |
| `test`    | `development` | No         |

Custom targets are non-continuous by default and use `development` unless `--env` is provided. The built-in target runtime modes are `development` for `dev`, `test` for `test`, and `production` for `build`, `dist`, and `preview`. Custom targets may set `nodeEnv` to `development`, `production`, or `test`. Project roots default to `.`, target output directories default to `dist`, and artifact output defaults to `artifacts`. Targets may use a string array for ordered commands, such as `release: ['pnpm build', 'pnpm package']`. Artifact delivery defaults to `move` with ZIP as the archive format; set `artifacts.mode` to `archive` or `both` when needed. When artifact delivery is enabled, `artifacts.clean` defaults to `true` and clears the output directory before each non-continuous target runs, so materialized artifacts contain only the current execution's output. Archive mode keeps the current output directory, while move and both relocate it into the artifact directory. Artifact names use `<variant>-<version>-<YYYYMMDD-HHmmss>`, with five ArtifactSets retained by default per product, environment, and variant.

The action menu includes variant-specific targets and labels their applicable scope. Choosing one displays that scope explicitly in the configuration menu. When `--variant` is provided, actions must support every requested variant. Direct commands never silently drop unsupported variants: use `--variant` to narrow their scope. Variant adjustment requires at least one selection. Returning to actions resets wizard adjustments to the original CLI arguments and the new target's defaults.

`matrix plan app --target build` prints JSON without executing tasks. Each task's `env` shows the final merged values for variables declared in Matrix configuration, the selected product, and the active dotenv files, plus `MATRIX_*` and `NODE_ENV`. Shell overrides are reflected in these values; unrelated inherited Shell variables are omitted from the output but still passed to child processes. Values are not automatically redacted based on variable names, so plan output may contain secrets: do not paste it into public logs or issues. Complete plan commands emit JSON without interactive summaries.

Any configured target can be invoked from the CLI. `test`, `lint`, and `e2e` are common custom targets.

### Project preparation

Declare optional `project.prepare` commands using the same string or string-array format as target commands. Arrays run in order; empty commands and full target objects are not supported.

```ts
export default {
  projects: {
    desktop: {
      root: './apps/desktop',
      prepare: ['pnpm run setup', 'pnpm run generate'],
      targets: {
        dev: 'pnpm dev',
        build: 'pnpm build',
        lint: { command: 'pnpm lint', prepare: false },
      },
    },
  },
  products: { app: { variants: { desktop: 'desktop' } } },
}
```

- Preparation runs before the project's first eligible target, including projects reached through dependencies. Unrelated projects are not prepared.
- Projects are deduplicated by key within each invocation, even when shared by multiple products or variants. Preparation completes only after every command succeeds. There is no persistent completion cache; commands should be repeatable and manage their own resource caches.
- With artifact cleanup enabled, the order is: clean the target output directory, prepare if needed, run the target, then deliver artifacts. Later variants may still clean or move the output directory. Keep reusable preparation files outside target output directories; generate per-build output files in the target command array rather than in one-time project preparation.
- `target.prepare: false` skips preparation only for that target; later eligible targets still trigger it. Failure or cancellation stops execution before subsequent targets start.
- Commands run in the project root with global configuration, selected dotenv, and Shell values, without merging product env or injecting product/variant identity. They do not inherit a target's default NODE_ENV; global/external values are preserved. Matrix injects `MATRIX_PROJECT`, `MATRIX_ENV_NAME`, and `MATRIX_TARGET=prepare`.
- `matrix prepare [product]` explicitly prepares projects referenced by the selected product (all products if omitted), then generates runtime types without running business targets. Build-plugin type generation is unchanged.
- `matrix plan` lists preparation commands, working directories, environments, and `beforeTask` in its JSON `preparations` field. `doctor` only validates configuration and dependencies. Neither executes preparation.

`project.prepare` is separate from an ordinary target named `prepare`. Preparation never recursively prepares itself and does not support dependencies, continuous services, or artifact settings.

## Commands

Short options: `-p` / `--product`, `-t` / `--target`, `-e` / `--env`, `-v` / `--variant`, and `-h` / `--help`. The former `--mode` alias has been removed; use `--env` or `-e` instead. Mixing aliases for the same option is rejected, except repeatable variants. Interactive equivalent commands use short options.

Node's strict argument parser handles option syntax; Matrix validates duplicate selections, variant lists, and command-specific combinations. Help is generated from the same option definitions. Both `--env=staging` and the existing `-e=staging` spelling are supported.

```bash
matrix dev app -v desktop -e staging
matrix plan app -t build -e production
matrix -p app # Continue by selecting an action interactively
```

For a custom target named `help`, `plan`, `doctor`, or `prepare`, use explicit target selection, for example `matrix -p app -t prepare -e development`. Generated equivalent commands use this form to avoid invoking the built-in command instead.

```text
matrix [target] [product] [--variant name] [--env <environment>]
matrix --product <product> [--target <target>] [--variant name] [--env <environment>]
matrix dev [product]
matrix build [product] [--env <environment>]
matrix dist [product] [--env <environment>]
matrix preview [product] [--env <environment>]
matrix test [product] [--env <environment>]
matrix plan [product] [--target <target>] [--env <environment>]
matrix doctor
matrix prepare [product] [--env <environment>]
matrix <custom-target> [product] [--env <environment>]
```

## Development

Keep `examples/basic` for the framework-free introduction. The [dual-Web/shared-Electron example](examples/electron-web/README.md) exercises two products through preparation, development dependencies, packaging, and real application startup. Run `pnpm test:electron-web` to verify the current tarball in a temporary consumer, or `pnpm example:electron-web` to install it into the local example for manual exploration.

CI runs on pull requests, main pushes, and manual dispatch. A Node 24 job checks lint and types. Six compatibility jobs cover Ubuntu, macOS, and Windows with exact Node 22.18.0 and Node 24.x. Each runs behavior tests and package smoke; the Node 24 jobs additionally run real Electron/Web acceptance. POSIX-only signal assertions explicitly skip Windows, while portable cancellation and execution behavior remain covered.

Dependency versions are maintained in the pnpm catalog in `pnpm-workspace.yaml`.

```bash
pnpm install
pnpm check
pnpm lint:fix
```

`pnpm lint:fix` formats JavaScript, TypeScript, and Markdown through ESLint. `pnpm check` runs lint, typecheck, tests, and the production build without starting example services.

`pnpm test:pack` installs the packed package into a temporary consumer and checks exports, configuration isolation, preparation, and CLI shutdown. The shutdown check uses two minimal processes without network ports; on macOS/Linux it sends SIGINT to Matrix and verifies exit code 130, cleanup completion, and no remaining fixture processes. This POSIX signal check is explicitly skipped on Windows; the other package checks still run. Successful runs print a short summary and failures include diagnostics. The release workflow runs both `pnpm check` and `pnpm test:pack`.

## License

[MIT](LICENSE)
