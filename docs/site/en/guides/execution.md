# Execution and artifacts

## Targets and defaults

The built-in targets use these defaults:

| Target    | Configuration environment | Node mode     | Continuous |
| --------- | ------------------------- | ------------- | ---------- |
| `dev`     | `development`             | `development` | Yes        |
| `build`   | `production`              | `production`  | No         |
| `dist`    | `production`              | `production`  | No         |
| `preview` | `production`              | `production`  | Yes        |
| `test`    | `development`             | `test`        | No         |

Custom targets are non-continuous by default and use `development` unless `--env` is provided. The built-in target runtime modes are `development` for `dev`, `test` for `test`, and `production` for `build`, `dist`, and `preview`. Custom targets may set `nodeEnv` to `development`, `production`, or `test`. Project roots default to `.`, target output directories default to `dist`, and artifact output defaults to `artifacts`. Targets may use a string array for ordered commands, such as `release: ['pnpm build', 'pnpm package']`. Artifact delivery defaults to `move` with ZIP as the archive format; set `artifacts.mode` to `archive` or `both` when needed. When artifact delivery is enabled, `artifacts.clean` defaults to `true` and clears the output directory before each non-continuous target runs, so materialized artifacts contain only the current execution's output. Archive mode keeps the current output directory, while move and both relocate it into the artifact directory. Artifact names use `<variant>-<version>-<YYYYMMDD-HHmmss>`, with five ArtifactSets retained by default per product, environment, and variant.

## Execution summaries and failures

Execution prints one final summary after child-process cleanup on success, failure, or cancellation. It includes the overall outcome and elapsed time, each task and project preparation's outcome, and generated artifact paths. `matrix prepare` waits until type generation finishes and includes generated declaration paths in the same summary.

- Finite tasks are `completed` only after their commands and configured artifact delivery succeed. A failed task is `failed`; tasks and preparations that never started remain `not run`.
- Interrupted finite work is `cancelled` on user cancellation. Continuous services are `stopped`, not completed, when they exit normally or Matrix shuts them down. Other work interrupted by a background service failure is also `stopped`, not failed.
- Failures identify the exact `product:variant:target`, phase (`preparation`, `command`, `readiness`, or `artifact handling`), and underlying error or exit code. Ordered commands include the failing step number. Project preparation failures identify the project and affected task when available; cleanup failures are reported separately.

Execution remains serial, with child output and terminal interaction passed through unchanged. Matrix's progress identifies tasks and command steps without echoing configured command strings or dumping environments. Diagnostics retain error messages and paths without guessing sensitive keys or replacing values; Matrix strips terminal control characters from its own diagnostic lines. Error messages, paths, and child-process output may contain secrets: review them before publishing logs. Child-process output is not captured or modified. Existing CLI exit codes remain unchanged: execution failures use `1`, SIGINT uses `130`, and SIGTERM uses `143`. See [execution plans](../reference/cli.md#execution-plans) for the separate disclosure boundary of `matrix plan` JSON.

## Project preparation

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

## Process shutdown

Process-tree shutdown uses the system `ps` command on macOS/Linux (install `procps` in minimal Linux images) and `taskkill.exe` on Windows. POSIX tasks receive SIGTERM, followed by SIGKILL after 30 seconds if needed; Matrix waits for the controlled process group to stop, not just its shell.

## Artifact delivery

Delivery is opt-in per target. A target without `artifacts` leaves its output in place and does not perform Matrix's pre-run cleanup. Root `artifacts` only configures destination and retention. Continuous targets do not perform artifact cleanup or delivery.

For a finite target, the order is **clean output → prepare project if needed → execute commands → deliver artifacts → prune old sets**. Set `clean: false` when intentionally reusing earlier output; Matrix then cannot guarantee that the delivered set contains only the current build.

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  artifacts: { root: './artifacts', retention: { keep: 3 } },
  projects: {
    web: {
      root: './apps/web',
      targets: {
        build: {
          command: 'pnpm build',
          outputDir: 'dist',
          artifacts: { mode: 'archive', format: 'tar.gz', clean: true },
        },
      },
    },
  },
  products: { app: { version: '1.0.0', variants: { web: 'web' } } },
})
```

| Mode      | Result under `<artifacts.root>/<product>/<environment>/`       | Source output  |
| --------- | -------------------------------------------------------------- | -------------- |
| `move`    | `<variant>-<version>-<timestamp>/`                             | Moved away.    |
| `archive` | `<variant>-<version>-<timestamp>.zip` or `.tar.gz`             | Kept in place. |
| `both`    | Moved directory containing the output and its matching archive | Moved away.    |

The timestamp is `YYYYMMDD-HHmmss` in the executing machine's local time. Retention counts artifact sets across versions, not individual files, per product/environment/variant; `both` counts as one set. Successful delivery prunes older matching sets. Target names are not part of the grouping. An existing destination is an error, not an overwrite.

An artifact target needs a valid resolved release version and an existing output directory after commands finish. Cleanup rejects the project root and its ancestors, but still deletes the configured output directory; keep sources and shared preparation caches elsewhere. Run `matrix doctor` before first use and inspect the configured paths. A subsequent `preview` needs a retained/rebuilt output directory if the build used `move` or `both`.

Execution follows the plan serially; continuous services may remain alive while later tasks start. Matrix is not a parallel build scheduler or a cross-invocation lock for shared directories.
