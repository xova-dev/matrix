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

Mixed Nuxt defaults to `['VITE_', 'NUXT_PUBLIC_']`. An `Ambiguous environment fields` error means different original keys map to one camelCase config property, including aliases collected from different products. Equal values do not resolve the ambiguity. Keep one original name, or set an explicit `envPrefix` to replace the defaults and exclude the alias; do not expose private prefixes. This does not affect product/environment overrides of the same original key.

## A virtual runtime import or its types cannot be found

Install/configure the Matrix plugin in the actual host build; declarations alone do not implement `virtual:matrix/runtime`. Run `matrix prepare app`, include `.matrix/types` in the consuming project's `tsconfig.json`, and match the import suffix to the plugin scope. For example, scope `main` uses `virtual:matrix/runtime/main`.

Keep Electron main/preload in different scopes and include custom type-output paths when used. Automatic plugin generation is disabled by default in Vitest; `types: true` enables it explicitly. `types: false` also disables preparation output. Standalone builds not launched through Matrix do not receive Matrix's internal schema context.

If host discovery fails, set project `configFile` explicitly. Standard names with JS/TS module extensions, or explicitly selected extensionless `nuxt.config`, `electron.vite.config`, and `vite.config`, identify their host without `configHost`. Only unrecognized filenames require `configHost`; extensionless files are not discovered automatically. The selected host's loader/version determines supported syntax and may reject an extensionless config even when Matrix identifies the host. Other hosts retain generic preparation instead of host-config resolution. Native projects with `typegen: false` skip discovery. Old declaration files are not automatically removed; inspect obsolete files when changing scopes/output paths. See [type preparation](integrations.md#type-preparation).

## Bundled values do not change or a snapshot cannot be mutated

The virtual runtime is an immutable build-time snapshot, not deployment-time configuration. Restart the dev/build context after environment changes and rebuild when shipping new values. Copy values into application-owned state instead of writing to `matrix`, `matrix.product`, or `matrix.config`.

Tree shaking requires supported static reads and host optimization. Dynamic keys, destructuring, aliases, or side-effectful static imports do not have the same removal guarantee. For esbuild/custom loader conflicts, put required source loaders first or use `matrix({ inline: false })`; that disables Matrix inlining, not the virtual module. See [integration boundaries](integrations.md#immutable-snapshots-and-tree-shaking).

## Artifacts are missing or preview cannot find dist

Root `artifacts` does not enable delivery; enable target `artifacts`. The finite command must succeed, its output directory must exist, and a valid version must resolve from environment, variant, product, or that project's `package.json`. Parent package versions are not searched.

`move` and `both` relocate the source output; use `archive` when another target must consume it in place. `clean` defaults to true and may remove output before later targets run. Keep shared preparation files outside output directories. Retention is shared across target names for the same product/environment/variant. See [artifact delivery](execution.md#artifact-delivery).

## Project preparation runs multiple times

Preparation now receives the full product/variant identity, resolved version and host mode. Shared type collection prepares each related dev/build context, then execution reestablishes the active target's inputs. Keep scripts repeatable and move input generation from target arrays into `project.prepare`. There is no once-per-project completion cache. `target.prepare: false` only skips that target context during automatic execution; explicit prepare still establishes all selected inputs. If values are missing, check that the installed Matrix includes this lifecycle change. See [migration and shared-directory rules](execution.md#project-preparation).

## Shutdown fails in a minimal image

Check system process-management support: macOS/Linux require `ps` (install `procps` in minimal Linux images). Windows requires the built-in Windows PowerShell/.NET runtime and permission to compile its local Job Object helper with `Add-Type`. Matrix refuses unowned execution if this fails; it does not fall back to `taskkill` after a parent exits. On POSIX, Matrix sends SIGTERM and may send SIGKILL after 30 seconds; it waits for the controlled process group. See [shutdown](execution.md#process-shutdown).
