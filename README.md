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
MATRIX_PRODUCT_VERSION
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

### Environment schema

Declare types, defaults, and optionality once in root-level `envSchema`. Products still override values through `env` / `$env`; they do not declare separate schemas or infer types from overrides:

```ts
export default defineMatrixConfig({
  envSchema: {
    VITE_RENDERER_MODE: { type: 'enum', values: ['remote', 'bundled'], default: 'remote' },
    VITE_CLOUD_SUBMISSION_ENABLED: { type: 'boolean', default: false },
    VITE_RETRY_COUNT: { type: 'number', default: 3 },
    VITE_LABEL: { type: 'string', optional: true },
  },
  projects: { web: { targets: { build: 'vite build' } } },
  products: {
    app: {
      env: { VITE_RENDERER_MODE: 'bundled' },
      variants: { web: 'web' },
    },
  },
})
```

`defineMatrixConfig()` constrains global, product, and `$env` inputs from the root declaration, including enum defaults. Defaults use native types. Boolean overrides accept booleans or exactly `'true'` / `'false'`; numbers accept finite numbers or decimal/scientific-notation strings, not whitespace, empty strings, hexadecimal, NaN, or Infinity. Strings are not implicitly coerced; enums match strings exactly.

Precedence remains `schema default < global env/$env < product env/$env < dotenv < process.env`. Defaults only fill missing fields. Invalid final overrides fail without falling back; errors identify the field and expected type, not its value. Undeclared fields retain their existing behavior.

For builds launched through Matrix, `matrix.config.cloudSubmissionEnabled` is a boolean, `retryCount` is a number, and `rendererMode` has an enum literal-union type. Raw `process.env` and generated `ImportMetaEnv` fields remain strings. An absent `optional: true` field without a default is omitted from the runtime object and gets a `?` property; defaulted fields are non-optional. Both `matrix prepare` and build adapters generate types from the declaration, without writing actual values or non-public fields into type files.

Required-field checks apply to the consuming adapter's public prefixes: a Web build using `VITE_` does not require missing `MAIN_VITE_*` fields. Planned tasks and preparation commands validate present values in their own final environments and apply defaults, without globally requiring every field. Type generation itself does not require values. Vite validates fields within the final `envPrefix` when configuration is resolved; other adapters validate at build startup. Validation does not depend on importing the runtime module and still runs with type generation disabled. Required declarations apply to all projects consuming the same prefix; use distinct prefixes or optional declarations for project-specific fields. Present non-public values are validated too, but applications own their missing-value checks. `scope` still isolates module and declaration files; `envPrefix` still controls exposure, and schemas never expand it. Ambiguous public property mappings involving schema fields are rejected to avoid mismatched types and values.

Matrix passes the schema to adapters through internal child-process context, never through `matrix.config`. Standalone builds not launched by Matrix keep the existing string behavior. `MATRIX_*`, `__MATRIX_*`, and `NODE_ENV` are reserved and cannot be declared in a schema. Plan output may still contain actual declared environment values and should not be posted publicly.

### Product release versions

Products sharing a project can declare independent release versions, with optional variant overrides:

```ts
export default {
  products: {
    alpha: {
      version: '2.0.0',
      variants: { desktop: 'desktop' },
    },
    beta: {
      version: '3.0.0',
      variants: { desktop: { project: 'desktop', version: '3.1.0-rc.1' } },
    },
  },
}
```

Precedence is `MATRIX_PRODUCT_VERSION > variant.version > product.version > project package.json version`. The environment override follows the existing global/product `env`, `$env`, dotenv, and Shell merge order. Versions use SemVer, including prerelease and build metadata. Identity suffixes are not applied; invalid explicit versions fail without falling back.

The version is resolved when the execution plan is created and shared by task `version`, child-process `MATRIX_PRODUCT_VERSION`, build-time `matrix.product.version`, and artifact names. Matrix does not modify source `package.json` files or automatically configure application packagers. For example, electron-builder can consume it through `extraMetadata: { version: process.env.MATRIX_PRODUCT_VERSION }`.

Without an explicit version, Matrix reads the selected project's `package.json`, without searching parent directories. Non-artifact tasks allow a missing file or `version` field and omit the version in that case. Finite tasks with artifact delivery require a valid resolved version. An explicit version removes the need for a project `package.json`.

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

#### Immutable snapshots and tree shaking

The existing import is also the static optimization entrypoint; no global or `import.meta.matrix` API is needed:

```ts
import { matrix } from 'virtual:matrix/runtime'

if (matrix.isDevelopment) {
  void import('./dev-tools')
}
```

Matrix resolves one immutable snapshot per plugin/build context. Its shared Oxc-based transform replaces known, present scalar property reads from the matching named import with literals, including renamed imports, dot access and string-literal keys. The bundler can then remove unreachable branches and their exclusive dynamic-import chunks. Vite, Rollup, esbuild and Webpack are covered by actual build tests; Electron main/preload use the same transform through electron-vite. Other hosts and framework loader combinations are not implicitly guaranteed. Static imports with side effects still follow the host's normal module semantics.

Dynamic keys, destructuring, object aliases, namespace imports and re-exports keep the virtual module as a fallback; Matrix does not promise to inline those uses. Unknown, inherited and absent optional properties also remain runtime reads. Passing or enumerating the snapshot is supported. Only public fields in the current scope are candidates, and booleans/numbers remain native scalars. Use one scope per compilation; in particular, esbuild does not chain transforms from separately registered plugin instances on the same source module.

All adapters load only their exact Matrix virtual module ID. Ordinary JS/TS files are eligible for static replacement; other resources retain their host behavior unless explicitly supported below. Webpack additionally checks the actual module type, so even JS-named assets remain untouched.

With Vite and the official `@vitejs/plugin-vue`, Matrix also optimizes compiled Vue scripts, including `<script setup lang="ts">` and ordinary `<script>` blocks. It reuses Vue's compilation and source maps instead of parsing SFCs itself. Client production builds, SSR and the development pipeline are tested. Template/style/custom blocks and raw/url imports remain outside the transform; other frameworks and custom Vue query formats are not implicitly supported.

For esbuild, only the file namespace is eligible; import attributes and non-script loaders are left to their owners. Register any required source-loading plugins **before Matrix**. Their files keep the immutable runtime fallback; Matrix can still inline other files they do not own. Registering Matrix first is unsupported when a later loader must process the same source, because esbuild accepts the first returned contents instead of chaining loaders:

```ts
plugins: [customSourceLoader(), matrix()]
```

For complex loader combinations, use `matrix({ inline: false })` to disable Matrix's source transforms. This option applies to all adapters and defaults to `true`; virtual modules, public-field and scope boundaries, frozen snapshots, and type generation remain unchanged. Matrix no longer reports writes at build time, but runtime freezing still prevents mutation. Removal of development branches and exclusive chunks is no longer guaranteed. With this option, esbuild does not register Matrix's source loader, so `plugins: [matrix({ inline: false }), customSourceLoader()]` is supported; ordering among other plugins still follows the host's rules.

Files without an actual Matrix replacement pass through. Vite/Rollup and Webpack preserve upstream source maps; esbuild composes valid inline maps, while external or unsupported maps retain the host loader without an inlining guarantee. These paths are covered by real-build mapping tests.

**Compatibility change:** the root, `product` and `config` are now read-only in types and frozen at runtime. Recognized direct assignments, updates and deletions are build errors. Indirect mutation is prevented by the frozen objects (strict assignments throw; `Reflect.set` returns `false`). If an application needs mutable state, copy the relevant values into its own object. Mutating a Matrix snapshot is no longer supported in development or production.

Values are fixed when the plugin resolves its environment, not when the built application starts. Restart the development/build context after environment changes; `matrix prepare` still generates contracts without embedding environment values. Different products and scopes have separate snapshots.

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

Run `matrix prepare` before starting development to generate runtime declarations for the selected products. Scope stays in the build plugin configuration; it does not need to be repeated in `matrix.config`.

- By default, preparation checks files directly in the project root only: `electron.vite.config.*` takes priority over `vite.config.*`. It never searches subdirectories or parent directories. Multiple files matching the selected rule require an explicit choice. The locally installed host resolves the real configuration, including plugin hooks, `root`, `envDir`, `envPrefix`, `scope`, and `types` options. Electron main/preload declarations are generated separately, without starting Electron, a dev server, or a bundle build.
- Set `projects.desktop.configFile`, for example `'config/electron.vite.config.ts'`, to select a file relative to that project's root. This overrides automatic discovery; the basename must still match a supported rule (`electron.vite.config.*` or `vite.config.*`, with a JS/TS module extension). Missing, unsupported, or failing explicit configs are errors, never a reason to fall back. `configFile` only controls preparation and does not modify target commands; no separate host setting is needed.
- Preparation resolves the development configuration (`serve`; Electron main/preload use their normal development-time `build` configuration hooks), with `NODE_ENV=development` and `mode` set to the Matrix `--env` selection. Each product/variant is evaluated in an isolated process with `MATRIX_TARGET=prepare` and its product key, project, and variant. Product identity (ID/name/slug/appId, including suffixes and overrides) and version use the same resolution rules as execution plans; a missing package version is allowed when no version is configured. This is not a production build context; keep scope and type contracts independent of the selected product and target.
- Shared projects merge the selected products' public field names. Schema-declared fields do not need runtime values to generate their types. Duplicate scopes, conflicting outputs/prefixes, changing scope sets, and configuration failures are diagnosed before Matrix writes declarations. Preparation does execute configuration code and configuration hooks, in addition to the existing project preparation commands; it is not a side-effect-free static scan. Each host evaluation has a 30-second timeout.
- Projects with neither an explicit config nor a supported project-root config retain the generic `.matrix/types/matrix-runtime.d.ts` generation from Matrix configuration and public environment keys. Other hosts and arbitrary config basenames are not supported yet. A successfully resolved config without a Matrix plugin also retains this generic generation (using Matrix settings, not host-specific prefixes or scopes); an active plugin with `types: false` disables generation. Existing stale declaration files are not automatically deleted.

Both preparation and build plugins derive `ImportMetaEnv` and `matrix.config` types without writing environment values. Build plugins continue generating the current build's declaration from its final configuration. In a Vitest environment automatic build-plugin generation is disabled by default; `types: true` or `types: { output: '...' }` explicitly enables it. Explicit `matrix prepare` generates types regardless of Vitest, but honors `types: false`. Add the generated type directory to each project's `tsconfig.json`:

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

### Execution summaries and failures

Execution prints one final summary after child-process cleanup on success, failure, or cancellation. It includes the overall outcome and elapsed time, each task and project preparation's outcome, and generated artifact paths. `matrix prepare` waits until type generation finishes and includes generated declaration paths in the same summary.

- Finite tasks are `completed` only after their commands and configured artifact delivery succeed. A failed task is `failed`; tasks and preparations that never started remain `not run`.
- Interrupted finite work is `cancelled` on user cancellation. Continuous services are `stopped`, not completed, when they exit normally or Matrix shuts them down. Other work interrupted by a background service failure is also `stopped`, not failed.
- Failures identify the exact `product:variant:target`, phase (`preparation`, `command`, `readiness`, or `artifact handling`), and underlying error or exit code. Ordered commands include the failing step number. Project preparation failures identify the project and affected task when available; cleanup failures are reported separately.

Execution remains serial, with child output and terminal interaction passed through unchanged. Matrix's progress identifies tasks and command steps without echoing configured command strings or dumping environments. Diagnostics retain error messages and paths without guessing sensitive keys or replacing values; Matrix strips terminal control characters from its own diagnostic lines. Error messages, paths, and child-process output may contain secrets: review them before publishing logs. Child-process output is not captured or modified. Existing CLI exit codes remain unchanged: execution failures use `1`, SIGINT uses `130`, and SIGTERM uses `143`. `matrix plan` JSON is unchanged and retains the value-disclosure caveat above.

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
- `matrix plan` lists preparation commands, working directories, environments, and `beforeTask` in its JSON `preparations` field. `doctor` performs static preflight checks. Neither executes preparation.

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

### Static preflight

`matrix doctor [--env <environment>]` checks all configured products, variants, and targets in the selected environment without running target/preparation commands, probing ports, generating types, or cleaning output. Configuration loading still evaluates the configuration file as usual.

- Errors include missing/non-directory project roots, cleanup of a project root or ancestor, and planning errors such as invalid dependencies or unavailable artifact versions. Version precedence and cleanup safety use the same rules as execution.
- Warnings identify `completed` dependencies on continuous tasks and `ready` dependencies without `readyWhen`; starting a process alone does not establish service readiness.
- Dependency planning failures retain their original task and configuration source. The same failure is reported once, with affected downstream tasks listed as `Blocked` rather than counted as additional errors.
- Diagnostics identify the project/task and configuration path and suggest a correction, without printing environment values. Independent checks are aggregated after configuration loads successfully; invalid configuration that cannot be loaded still fails immediately. Errors exit nonzero; warnings alone exit successfully.
- Missing pre-build output directories and shared serial output directories are allowed. Doctor does not infer application environment requirements or automatically fix files.

## Development

See the [examples guide](examples/README.md) for workspace setup and verification boundaries. `examples/basic` is the framework-free introduction; the [dual-Web/shared-Electron example](examples/electron-web/README.md) exercises preparation, development dependencies, packaging and real application startup. After `pnpm install --frozen-lockfile` and `pnpm build`, run `pnpm example:basic` for the interactive introduction or `pnpm example:electron-web` to prepare the Electron workspace. `pnpm check:examples` checks both Matrix configurations. `pnpm test:electron-web` separately verifies the current tarball in a temporary, lockfile-pinned consumer outside the workspace.

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
