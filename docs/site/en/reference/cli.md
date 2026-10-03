# CLI reference

## Interactive and direct commands

Run `matrix` for Product → Action → Configuration. Unique choices are selected automatically. The compact configuration menu shows the current variants and environment; run immediately, edit either field, view execution details, or return to the action list. Details include dependencies, Node mode, and the equivalent command. One run selects one product; adjustments are not remembered between runs.

In supported interactive terminals, the wizard uses a temporary alternate screen and replaces the previous page instead of accumulating selection history. Run, cancel, and error paths restore the original terminal; execution prints one final summary and leaves task logs on the normal screen. `ACCESSIBLE=1`, Clack accessibility settings, and `TERM=dumb` / `TERM=unknown` keep prompts on the normal screen without switching screens or clearing pages. Complete commands and non-interactive runs never enter the temporary screen.

Complete commands such as `matrix dev app` run immediately, even in a terminal: the environment defaults from the target and the scope defaults to all variants. Incomplete commands such as `matrix dev` or `matrix --product app` prompt only for missing product/action choices, then show the configuration menu. Outside a terminal or in CI, ambiguous product/action selections fail with guidance instead of prompting. Use `--product` and `--target` for explicit selections, `--help` for examples, and `--env=name` or repeated `--variant` / `-v` options when convenient.

For CI detection, unset, empty, `false`, and `0` values allow interactive mode when both input and output are terminals. Values are trimmed and case-insensitive; other non-empty values disable prompts and temporary screens.

The action menu includes variant-specific targets and labels their applicable scope. Choosing one displays that scope explicitly in the configuration menu. When `--variant` is provided, actions must support every requested variant. Direct commands never silently drop unsupported variants: use `--variant` to narrow their scope. Variant adjustment requires at least one selection. Returning to actions resets wizard adjustments to the original CLI arguments and the new target's defaults.

## Commands

The examples use `matrix` as shorthand for the installed CLI. With a local pnpm dependency, run `pnpm exec matrix ...`, or invoke it from a package script.

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

## Static preflight

`matrix doctor [--env <environment>]` checks all configured products, variants, and targets in the selected environment without running target/preparation commands, probing ports, generating types, or cleaning output. Configuration loading still evaluates the configuration file as usual.

- Errors include missing/non-directory project roots, cleanup of a project root or ancestor, and planning errors such as invalid dependencies or unavailable artifact versions. Version precedence and cleanup safety use the same rules as execution.
- Warnings identify `completed` dependencies on continuous tasks and `ready` dependencies without `readyWhen`; starting a process alone does not establish service readiness.
- Dependency planning failures retain their original task and configuration source. The same failure is reported once, with affected downstream tasks listed as `Blocked` rather than counted as additional errors.
- Diagnostics identify the project/task and configuration path and suggest a correction, without printing environment values. Independent checks are aggregated after configuration loads successfully; invalid configuration that cannot be loaded still fails immediately. Errors exit nonzero; warnings alone exit successfully.
- Missing pre-build output directories and shared serial output directories are allowed. Doctor does not infer application environment requirements or automatically fix files.

## Execution plans

`matrix plan app --target build` prints JSON without executing tasks. Each task's `env` shows the final merged values for variables declared in Matrix configuration, the selected product, and the active dotenv files, plus `MATRIX_*` and `NODE_ENV`. Shell overrides are reflected in these values; unrelated inherited Shell variables are omitted from the output but still passed to child processes. Values are not automatically redacted based on variable names, so plan output may contain secrets: do not paste it into public logs or issues. Complete plan commands emit JSON without interactive summaries.

Any configured target can be invoked from the CLI. `lint`, `e2e`, and `release` are examples of custom targets.

## Selection scope and CI

`--variant` / `-v` accepts comma-separated and repeatable values, such as `matrix build app -v web,desktop`. Dependencies still expand automatically. `doctor` accepts only `--env` and checks every product; `prepare` accepts an optional product and `--env`, not variants or a target. A run selects one product; CI must specify it when omission is ambiguous.
