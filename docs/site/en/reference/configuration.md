# Configuration reference

Use this page to look up `matrix.config.ts` fields, defaults, and override contracts. See [core concepts](../concepts.md) for the model and multi-variant example.

## Root configuration

Use `matrix.config.ts` in the workspace root, export `defineMatrixConfig({...})`, and run the CLI from that directory. These tables describe user configuration, not normalized plan input.

| Field                      | Type / default                     | Purpose                                                                                               |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `projects`                 | Project map; required              | Reusable project directories and commands.                                                            |
| `products`                 | Product map; required              | Deliverables assembled from project-backed variants.                                                  |
| `env`                      | Scalar map; optional               | Global string, number, or boolean values.                                                             |
| `$env`                     | Environment map; optional          | Global environment overrides; each entry contains `env`.                                              |
| `envSchema`                | Field map; optional                | Shared types, defaults, and optionality; see [schemas](../guides/environments.md#environment-schema). |
| `suffixes`                 | Environment → suffix map; optional | Default suffixes for product identity.                                                                |
| `artifacts.root`           | String; `artifacts`                | Destination relative to the workspace root; does not enable delivery.                                 |
| `artifacts.retention.keep` | Positive integer; `5`              | Artifact sets retained per product, environment, and variant.                                         |

## Projects

Preparation behavior is in [execution](../guides/execution.md#project-preparation). Supported host filenames and type generation are in [integration](../guides/integrations.md#type-preparation). Changing `configFile` does not change target commands.

| Field        | Type / default                             | Purpose                                                                  |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------ |
| `root`       | String; `.`                                | Project directory relative to the workspace root; commands run here.     |
| `targets`    | Target map; required                       | Project commands; built-in names supply defaults, not commands.          |
| `prepare`    | String or non-empty string array; optional | Finite preparation commands, once per project per invocation.            |
| `configFile` | String; optional                           | Host config relative to the project root, used only by `matrix prepare`. |

## Products

Product keys are used by CLI commands. Stable product IDs may differ from those keys.

| Field          | Type / default                     | Purpose                                                               |
| -------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `variants`     | Variant map; required              | Product-local variant keys referencing projects.                      |
| `id`           | String; product key                | Stable product ID.                                                    |
| `name`, `slug` | String; product key                | Display name and filesystem-facing identity.                          |
| `appId`        | String; optional                   | Application identifier.                                               |
| `version`      | SemVer string; optional            | Release version; see [version resolution](#product-release-versions). |
| `env`, `$env`  | Optional                           | Product values and environment overrides.                             |
| `suffixes`     | Environment → suffix map; optional | Product-level identity suffixes.                                      |

## Variants

A variant is a project-key string, such as `web: 'web'`, or an object. Variants do not declare `env`, `$env`, or `envSchema`; put application differences in product values or separate projects/products.

| Field                   | Type / default                        | Purpose                                                 |
| ----------------------- | ------------------------------------- | ------------------------------------------------------- |
| `project`               | String; required                      | Existing project key.                                   |
| `name`, `slug`, `appId` | String; inherited from product        | Identity overrides for this variant.                    |
| `version`               | SemVer string; inherited from product | Variant release version.                                |
| `suffixes`              | Environment → suffix map; optional    | Variant-level identity suffixes.                        |
| `targets`               | Override map; optional                | Override project targets or add targets with a command. |

## Target overrides

Object overrides preserve omitted project target fields; `readyWhen` and `artifacts` merge with base settings. A supplied `dependsOn` array replaces the base list, so `dependsOn: []` removes inherited dependencies. A string or string-array override replaces the entire target and reapplies target-name defaults; it does not preserve dependencies, artifacts, or readiness settings.

For example, `build: { command: 'pnpm build:desktop' }` keeps base settings, while `build: 'pnpm build:desktop'` resets them. A new object target must supply `command`.

## Targets

Targets accept a command string, an ordered non-empty string array, or an object. Commands must be non-empty. They run through the system shell in the project root; quoting and command availability are platform-dependent. Continuous targets cannot use command arrays. See [target defaults](../guides/execution.md#targets-and-defaults).

| Field        | Type / default                                                 | Purpose                                                    |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `command`    | String or string array; required                               | Command or ordered steps.                                  |
| `prepare`    | Boolean; enabled unless `false`                                | Skip project preparation for this target only.             |
| `continuous` | Boolean; depends on target name                                | Long-running service rather than finite work.              |
| `nodeEnv`    | `development`, `production`, or `test`; depends on target name | Generated `NODE_ENV` and `MATRIX_NODE_ENV`.                |
| `readyWhen`  | Port probe; optional                                           | Readiness check requested by a dependent target.           |
| `dependsOn`  | Dependency array; `[]`                                         | Other variants of the same product that run first.         |
| `outputDir`  | String; `dist`                                                 | Output directory relative to the project root.             |
| `artifacts`  | Object; absent by default                                      | Enable delivery for finite targets; `{}` enables defaults. |

## Readiness probes

Configure the probe on the service being depended on, not its consumer:

| Field     | Type / default              | Purpose                                 |
| --------- | --------------------------- | --------------------------------------- |
| `type`    | `'port'`; required          | Only TCP port readiness is supported.   |
| `port`    | Integer `1–65535`; required | Port that must accept a TCP connection. |
| `host`    | String; `127.0.0.1`         | Host to connect to.                     |
| `timeout` | Positive integer; `30000`   | Maximum wait in milliseconds.           |

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: {
          command: 'pnpm dev',
          readyWhen: { type: 'port', host: '127.0.0.1', port: 5173, timeout: 30_000 },
        },
      },
    },
  },
  products: { app: { variants: { web: 'web' } } },
})
```

A listening port does not prove HTTP/API health or ownership by that process. Without `readyWhen`, a `ready` dependency proceeds after process startup without a probe; `matrix doctor` warns about this. An unreferenced service's probe is not a global startup check.

## Dependencies

Use `dependsOn: ['web']` or `dependsOn: [{ variant: 'web', target: 'build', condition: 'completed' }]`.

| Field       | Type / default              | Purpose                                                                            |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `variant`   | String; required            | Variant key in the same product, not a project key.                                |
| `target`    | String; current target name | Target to run on the dependency.                                                   |
| `condition` | `ready` or `completed`      | Defaults to `ready` if the dependency target is continuous; otherwise `completed`. |

Dependencies expand recursively before consumers; cycles and missing variants/targets are errors. `--variant` selects entry variants without removing their dependencies. `completed` on a long-running service waits for it to exit and is usually inappropriate.

## Artifact settings

These settings belong to target `artifacts`. Destination and retention belong to root `artifacts`; see [artifact delivery](../guides/execution.md#artifact-delivery).

| Field    | Type / default                       | Purpose                                                     |
| -------- | ------------------------------------ | ----------------------------------------------------------- |
| `mode`   | `move`, `archive`, or `both`; `move` | Move output, archive it, or move it with an archive inside. |
| `format` | `zip` or `tar.gz`; `zip`             | Archive format; unused in move-only mode.                   |
| `clean`  | Boolean; `true`                      | Clear output before finite execution.                       |

## Identity suffixes

Each `suffixes.<environment>` entry accepts optional `name`, `slug`, and `appId` strings:

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {},
  products: {},
  suffixes: {
    staging: { name: ' (Staging)', slug: '-staging', appId: '.staging' },
  },
})
```

For the selected environment, suffix fields merge in `global < product < variant` order. More specific fields replace earlier suffixes; suffixes are not concatenated across levels. The final suffix is appended once after merged-environment identity overrides. For example, `com.example.app` becomes `com.example.app.staging`. An absent `appId` stays absent. Suffixes do not change product key, stable ID, or release version.

## Product release versions

Products sharing a project can declare independent release versions, with optional variant overrides:

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    desktop: {
      root: './apps/desktop',
      targets: { build: 'pnpm build' },
    },
  },
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
})
```

Precedence is `MATRIX_PRODUCT_VERSION > variant.version > product.version > project package.json version`. The environment override follows the existing global/product `env`, `$env`, dotenv, and Shell merge order. Versions use SemVer, including prerelease and build metadata. Identity suffixes are not applied; invalid explicit versions fail without falling back.

The version is resolved when the execution plan is created and shared by task `version`, child-process `MATRIX_PRODUCT_VERSION`, build-time `matrix.product.version`, and artifact names. Matrix does not modify source `package.json` files or automatically configure application packagers. For example, electron-builder can consume it through `extraMetadata: { version: process.env.MATRIX_PRODUCT_VERSION }`.

Without an explicit version, Matrix reads the selected project's `package.json`, without searching parent directories. Non-artifact tasks allow a missing file or `version` field and omit the version in that case. Finite tasks with artifact delivery require a valid resolved version. An explicit version removes the need for a project `package.json`.
