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

- `prepare` is an independent lifecycle, not the first command of a target. Matrix resolves the context, executes the preparation array in order, discovers/loads the host, collects types, and only then starts target commands. Custom targets also run their declared preparation, without automatic host type collection.
- Every preparation receives the full product, variant, selected environment, resolved identity/version and target Node mode. `MATRIX_TARGET` is the context being prepared (`dev` or `build` during shared collection), not the CLI action `prepare`. Commands run in the project root. Each array item is a separate shell process: files persist, but shell `cd` and `export` changes do not carry into the next item.
- Planning captures these contexts before user commands run, including additional products visited by shared collection and projects without preparation commands. Preparation, host collection and targets use the same snapshot: rewriting `package.json` during preparation does not change this invocation's resolved version. A new invocation reads the updated inputs. Errors in unused contexts are reported only if collection visits them.
- Shared type collection visits every related product/variant in both dev/build host contexts. Each visit establishes its own inputs before discovering the host, including a host config generated by preparation. After collection, Matrix prepares the active task again so it cannot consume another product's generated files. There is no per-project or persistent completion cache; scripts must be repeatable, preferably writing only changed content.
- `matrix prepare [product]` stops after preparation and declaration generation; it never runs business targets. A product selects projects, whose shared type owners may include other products. Native `typegen: false` projects still prepare both dev/build contexts of selected products, but never load hosts or join shared type ownership. Explicit prepare and automatic build/dev derive type collection from the selected type owners: when none exist, they run the selected preparation without resolving unrelated type-owner directories or publishing declarations. See [type preparation](./integrations.md#type-preparation).
- `target.prepare: false` skips user preparation for that target context during automatic execution/collection; it does not disable type collection or other contexts' preparation. Explicit `matrix prepare` always executes preparation. An opt-out is only appropriate when that context does not need generated inputs. Any failed command or cancellation prevents subsequent commands and host loading.
- With artifact cleanup enabled, the order is: clean the active target output, complete preparation/type collection, reestablish active inputs, run the target, then deliver artifacts. Keep shared preparation inputs outside target output directories that later tasks may clean or move.
- Matrix holds a workspace lock from preparation through target completion and child-process cleanup. Another invocation in that workspace waits (and can be cancelled). One execution session owns commands, host workers and filesystem operations. It acquires physical-path resource claims before starting a process or mutation, including symlink aliases and outputs outside the project root. Targets read their project/working directories and write their declared `outputDir`, even without artifact delivery or with `clean: false`. Preparation and host collection exclusively own their project roots; declaration publication, cleanup and delivery own their write directories. Read-only sharing is allowed; overlapping reads/writes or writes are rejected. Isolate directories or stop the conflicting service. Process claims remain held until the entire controlled process tree stops, including ordinary helpers spawned by host configs; only then can the next context prepare its inputs. Arbitrary scripts writing outside their declared directories must use separate workspaces or their own resource coordination. Do not recursively invoke Matrix from preparation/target commands in the same workspace.
- Automatic build/dev preparation first establishes the selected context and checks for its host. A native project with no host does not traverse unrelated type-owner roots, even without `typegen: false`. Shared-root expansion starts only when host type collection is needed.
- If the CLI dies during execution, Matrix cannot prove that its target processes have stopped. It retains the lock and refuses automatic recovery, rather than allowing another product to overwrite their inputs. A cleanup failure also retains ownership. Follow the reported lock path and remove it only after stopping all processes from the affected execution. An owner that died before execution began can still be recovered automatically.
- `matrix plan` lists the selected task preparations with commands, working directories, full contexts and `beforeTask`; runtime shared-type collection may visit additional related contexts. `doctor` remains a static preflight. Neither executes preparation; a generated explicit host config can consequently be reported missing by doctor before preparation.

**Migration:** `project.prepare` previously ran once per project with project-only environment. It now runs per context, potentially several times in one invocation, with product environment and resolved identity/version. Move input-generation commands out of target arrays into `project.prepare`, remove the duplicates, and make initialization commands repeatable. String and non-empty string-array syntax is unchanged; no `prepareHost`, hook object, or manual preliminary command is required.

`project.prepare` is separate from an ordinary target named `prepare`. Preparation never recursively prepares itself and does not support dependencies, continuous services, or artifact settings.

## Process shutdown

Commands and host workers use the same process ownership contract: a root result is separate from completed disposal. The execution session alone controls directory claims and waits for disposal before releasing them. Host workers use one message protocol on both platforms; cancellation first requests framework cleanup, then the backend drains the process container. A failed disposal retains ownership and the workspace lock.

Shutdown attempts every independent cleanup and waits for all of them. Dependent cleanup stays ordered: framework shutdown precedes process-container disposal, and directory ownership is released only after disposal succeeds. If execution and cleanup both fail, Matrix retains both causes; one failure never hides another or prevents the remaining cleanup attempts.

Process ownership covers the container, not just the original shell or worker. macOS/Linux use process groups and the system `ps` command (install `procps` in minimal Linux images). POSIX tasks receive SIGTERM, followed by SIGKILL after 30 seconds if needed.

Windows uses kernel Job Objects through the built-in Windows PowerShell/.NET runtime; policy must permit the local helper's `Add-Type` call. Matrix creates each command or host worker suspended with job membership established by the same native creation call (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), then resumes it. A supervisor crash between creation and resumption therefore cannot leave an unowned suspended process. Descendants remain in that job after their parent exits, including detached children. The session releases directory claims only after the job reports zero active processes. Coordinator disconnection drains the job; closing the owner handle also terminates its members. Startup failures retain their original cause while cleanup still stops the supervisor and attempts every transport release; cleanup failures remain failures. There is no fallback to PID-based cleanup or unowned execution. This process-scoped helper does not install software or change system execution policy.

## Artifact delivery

Delivery is opt-in per target. A target without `artifacts` leaves its output in place and does not perform Matrix's pre-run cleanup. Root `artifacts` only configures destination and retention. Continuous targets do not perform artifact cleanup or delivery.

For a finite target, the order is **clean output → complete context preparation → execute commands → deliver artifacts → prune old sets**. Set `clean: false` when intentionally reusing earlier output; Matrix then cannot guarantee that the delivered set contains only the current build.

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

Execution follows the plan serially; continuous services may remain alive while later tasks start. Matrix serializes invocations within the same workspace. It is not a parallel build scheduler and does not coordinate shared directories across distinct workspaces.
