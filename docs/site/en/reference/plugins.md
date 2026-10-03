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

| Option      | Default                                             | Purpose                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `envPrefix` | `VITE_` outside Vite; Vite uses its resolved prefix | String or string array of public prefixes. An explicit plugin option configures Vite's prefix too; `MATRIX_` is always added. Prefixes control exposure, not whether values reach the child process.                           |
| `scope`     | No scope                                            | Module/type isolation key, using only letters, digits, underscores, or hyphens. Use one scope per compilation.                                                                                                                 |
| `inline`    | `true`                                              | Replace supported static reads with literals; `false` keeps only the immutable virtual runtime integration.                                                                                                                    |
| `types`     | Enabled, except automatic generation in Vitest      | `false` disables declaration generation; `true` enables it; `{ output: '...' }` selects an output path relative to the generation root. Vite uses its resolved project root; other adapters use the current working directory. |

With a custom type output, include that file in the consuming project's `tsconfig.json`. Default declarations are `.matrix/types/matrix-runtime.d.ts`, or `.matrix/types/matrix-runtime-<scope>.d.ts` for a scope.

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
