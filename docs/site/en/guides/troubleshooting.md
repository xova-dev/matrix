# Troubleshooting

## Start with the selected context

From the directory containing `matrix.config.ts`, inspect `matrix --help`, run `matrix doctor --env staging`, then use `matrix plan app --target build --env staging` for the actual product/target. Doctor checks all products; a plan expands only the selected entries and their dependencies. Neither runs target or project preparation commands, but both evaluate configuration code.

Plan JSON may contain sensitive environment values. Do not publish it unreviewed. Execution logs pass child output through unchanged and are not automatically redacted either.

## A command is missing or the wrong target runs

Built-in names supply defaults, not framework commands. Declare the target under `projects.<key>.targets`. Use product keys for CLI selection and product-local variant keys for `--variant` and `dependsOn`. If only one variant supports an action, use `matrix preview app --variant web`; Matrix does not silently drop unsupported variants.

For a custom target named `help`, `plan`, `doctor`, or `prepare`, use explicit selection, such as `matrix -p app -t prepare`. If an override unexpectedly loses dependencies or artifacts, use an object override rather than a command string. See [configuration](../reference/configuration.md#target-overrides).

## No prompt appears in CI or an interactive run looks different

Complete commands such as `matrix dev app` execute directly, even in a terminal. The wizard fills missing product/action selections only when stdin and stdout are terminals and CI detection permits it. Use explicit product, target, environment, and variants in CI. `ACCESSIBLE=1` and unsupported terminal types keep prompts on the normal screen. See [CLI behavior](../reference/cli.md#interactive-and-direct-commands).

## A service times out or the consumer starts too early

Set `readyWhen` on the dependency service and ensure its actual host/port match the probe. The default host is `127.0.0.1`; the default timeout is 30 seconds. A `ready` dependency without a probe does not wait for application readiness. A TCP listener is not an HTTP health check. Check child logs and port conflicts before increasing the timeout.

Use `ready` for a running service and `completed` for finite build work. A shorthand dependency chooses its condition from the dependency target's `continuous` flag, not the consumer's. See [readiness and dependencies](../reference/configuration.md#readiness-probes).

## A staging build reports production mode or ignores a value

`MATRIX_ENV_NAME=staging` with `NODE_ENV=production` is expected for a staging build: environment and process mode are separate. Shell overrides win over dotenv and product/global values. Check the selected product and environment before editing schema defaults.

Only fields in public host prefixes enter `matrix.config`; adding an `envSchema` field does not expand those prefixes. `VITE_API_BASE` maps to `matrix.config.apiBase`. Boolean strings must be exactly `true` or `false`; an invalid final value fails rather than falling back. See [environments](environments.md).

## A virtual runtime import or its types cannot be found

Install/configure the Matrix plugin in the actual host build; declarations alone do not implement `virtual:matrix/runtime`. Run `matrix prepare app`, include `.matrix/types` in the consuming project's `tsconfig.json`, and match the import suffix to the plugin scope. For example, scope `main` uses `virtual:matrix/runtime/main`.

Keep Electron main/preload in different scopes and include custom type-output paths when used. Automatic plugin generation is disabled by default in Vitest; `types: true` enables it explicitly. `types: false` also disables preparation output. Standalone builds not launched through Matrix do not receive Matrix's internal schema context.

If host discovery fails, set project `configFile` explicitly; supported basenames remain `vite.config.*` or `electron.vite.config.*` with JS/TS module extensions. Other hosts retain generic preparation instead of host-config resolution. Old declaration files are not automatically removed; inspect obsolete files when changing scopes/output paths. See [type preparation](integrations.md#type-preparation).

## Bundled values do not change or a snapshot cannot be mutated

The virtual runtime is an immutable build-time snapshot, not deployment-time configuration. Restart the dev/build context after environment changes and rebuild when shipping new values. Copy values into application-owned state instead of writing to `matrix`, `matrix.product`, or `matrix.config`.

Tree shaking requires supported static reads and host optimization. Dynamic keys, destructuring, aliases, or side-effectful static imports do not have the same removal guarantee. For esbuild/custom loader conflicts, put required source loaders first or use `matrix({ inline: false })`; that disables Matrix inlining, not the virtual module. See [integration boundaries](integrations.md#immutable-snapshots-and-tree-shaking).

## Artifacts are missing or preview cannot find dist

Root `artifacts` does not enable delivery; enable target `artifacts`. The finite command must succeed, its output directory must exist, and a valid version must resolve from environment, variant, product, or that project's `package.json`. Parent package versions are not searched.

`move` and `both` relocate the source output; use `archive` when another target must consume it in place. `clean` defaults to true and may remove output before later targets run. Keep shared preparation files outside output directories. Retention is shared across target names for the same product/environment/variant. See [artifact delivery](execution.md#artifact-delivery).

## Project preparation has no product values or runs again

This is intentional: preparation is project-scoped, runs once per project key per invocation, and has no persistent completion cache. It uses global/dotenv/Shell values, not product identity or product env. Put product-specific generation in target commands, and make shared setup repeatable. `target.prepare: false` skips only that target; it does not disable later preparation. See [project preparation](execution.md#project-preparation).

## Shutdown fails in a minimal image

Check system process-management commands: macOS/Linux require `ps` (install `procps` in minimal Linux images), and Windows requires `taskkill.exe`. On POSIX, Matrix sends SIGTERM and may send SIGKILL after 30 seconds; it waits for the controlled process group. See [shutdown](execution.md#process-shutdown).
