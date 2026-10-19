# Plugin and runtime reference

## Build entrypoints

These entrypoints export the default `matrix()` factory for the corresponding host. See [build tool integration](../guides/integrations.md) for setup, Electron scopes, and transform boundaries.

| Entrypoint             | Host                 |
| ---------------------- | -------------------- |
| `@xova/matrix/vite`    | Vite / electron-vite |
| `@xova/matrix/rollup`  | Rollup               |
| `@xova/matrix/webpack` | Webpack              |
| `@xova/matrix/esbuild` | esbuild              |

The default virtual module is `virtual:matrix/runtime`; with a scope it is `virtual:matrix/runtime/<scope>`. The build plugin implements these modules; they are not directly resolvable files in the npm package.

## Plugin options

Pass these options to `matrix()` from the Vite, Rollup, Webpack, or esbuild entrypoint. They belong in the host configuration, not in `matrix.config.ts`.

| Option      | Default                                             | Purpose                                                                                                                                                                                              |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envPrefix` | `VITE_` outside Vite; Vite uses its resolved prefix | String or string array of public prefixes. An explicit plugin option configures Vite's prefix too; `MATRIX_` is always added. Prefixes control exposure, not whether values reach the child process. |
| `scope`     | No scope                                            | Module/type isolation key, using only letters, digits, underscores, or hyphens. Use one scope per compilation.                                                                                       |
| `inline`    | `true`                                              | Replace supported static reads with literals; `false` keeps only the immutable virtual runtime integration.                                                                                          |
| `types`     | Automatic with Matrix context, except in Vitest     | `false` disables generation; `true` or an object opts in, including in Vitest or without Matrix context. `{ output: '...' }` selects a custom path.                                                  |

**Default behavior change:** without Matrix CLI context, automatic generation leaves declarations untouched, creates no output directory, and warns once per plugin instance. This applies to all adapters. Run the target through Matrix or use `matrix prepare`. Runtime configuration may be incomplete; opting into type generation does not restore missing context.

Matrix CLI dev/build coordinates shared-project declarations for supported Vite/electron-vite configs before starting the host. The plugin retains that complete contract while runtime values remain active-product-only. Standalone explicit opt-ins and custom targets do not perform this workspace-wide collection; see [type preparation](../guides/integrations.md#type-preparation) for contexts, fallbacks, and limits.

Relative output paths resolve from Vite's resolved root or other adapters' working directory. The default is `.matrix/types/matrix-runtime.d.ts`, or `matrix-runtime-<scope>.d.ts` in the same directory for scoped builds. Include custom outputs in the project's `tsconfig.json`.

## Runtime fields

| Field                                     | Meaning                                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`                             | Selected Matrix configuration environment, such as `staging` or `qa`.                                                                                       |
| `target`                                  | Selected Matrix target, such as `build`.                                                                                                                    |
| `nodeEnv`                                 | Resolved Node process mode, distinct from the configuration environment.                                                                                    |
| `isDevelopment`, `isProduction`, `isTest` | Mode flags derived from `nodeEnv`.                                                                                                                          |
| `variant`, `project`                      | Variant and project keys for the build context.                                                                                                             |
| `product`                                 | Product `key`, `id`, `name`, `slug`, optional `appId`, and optional `version`.                                                                              |
| `config`                                  | Public environment fields with prefixes removed and names camel-cased; `VITE_API_BASE` becomes `apiBase`. Schema fields retain their declared scalar types. |

Only expose values intended to be present in the application bundle. A schema does not make a secret safe to publish. Matrix does not replace the application framework's own environment system.
