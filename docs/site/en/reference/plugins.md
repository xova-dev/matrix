# Plugin and runtime reference

## Build entrypoints

Bundler entrypoints export the default `matrix()` factory; the Nuxt entrypoint exports a Module. See [build tool integration](../guides/integrations.md) for native/mixed setup, Electron scopes, and transform boundaries.

| Entrypoint             | Host                       |
| ---------------------- | -------------------------- |
| `@xova/matrix/vite`    | Vite / electron-vite       |
| `@xova/matrix/nuxt`    | Nuxt Vite SSR / SPA Module |
| `@xova/matrix/rollup`  | Rollup                     |
| `@xova/matrix/webpack` | Webpack                    |
| `@xova/matrix/esbuild` | esbuild                    |

The default virtual module is `virtual:matrix/runtime`; with a scope it is `virtual:matrix/runtime/<scope>`. The build plugin implements these modules; they are not directly resolvable files in the npm package.

The Nuxt entrypoint exports a Module rather than a plugin factory. Register it in `modules`, optionally as `['@xova/matrix/nuxt', options]`. It supports SSR applications and `ssr: false` SPA, shares one public build snapshot across client/server, defaults business exposure to `['VITE_', 'NUXT_PUBLIC_']`, and automatically references declarations owned by Nuxt `rootDir`. Explicit `envPrefix` replaces that default; different original keys mapping to the same config field fail, even with equal values; type collection also checks aliases across products. It never maps or proxies `runtimeConfig`. See [mixed Nuxt integration](../guides/integrations.md#mixed-nuxt-ssr-and-spa-integration).

## Plugin options

Pass these options to `matrix()` from the Vite, Rollup, Webpack, or esbuild entrypoint. They belong in the host configuration, not in `matrix.config.ts`.

| Option      | Default                                             | Purpose                                                                                                                                                                                              |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envPrefix` | `VITE_` outside Vite; Vite uses its resolved prefix | String or string array of public prefixes. An explicit plugin option configures Vite's prefix too; `MATRIX_` is always added. Prefixes control exposure, not whether values reach the child process. |
| `scope`     | No scope                                            | Module/type isolation key, using only letters, digits, underscores, or hyphens. Use one scope per compilation.                                                                                       |
| `inline`    | `true`                                              | Replace supported static reads with literals; `false` keeps only the immutable virtual runtime integration.                                                                                          |
| `types`     | Automatic with Matrix context, except in Vitest     | `false` disables generation; `true` or an object opts in, including in Vitest or without Matrix context. `{ output: '...' }` selects a custom path.                                                  |

**Default behavior change:** without Matrix CLI context, automatic generation leaves declarations untouched, creates no output directory, and warns once per plugin instance. Run the target through Matrix or use `matrix prepare`. Runtime configuration may be incomplete; opting into type generation does not restore missing context.

For shared-project declarations in Matrix CLI dev/build, see [type preparation](../guides/integrations.md#type-preparation).

Relative output paths resolve from Vite's resolved root or other adapters' working directory. The default is `.matrix/types/matrix-runtime.d.ts`, or `matrix-runtime-<scope>.d.ts` in the same directory for scoped builds. Include custom outputs in the project's `tsconfig.json`.

For Nuxt, paths resolve from `rootDir`, not `srcDir`, and the Module handles type references, including custom outputs. `project.typegen: false` requires Module `types: false` for runtime-only mixed use; it does not disable virtual modules.

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
