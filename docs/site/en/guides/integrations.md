# Build tool integration

Matrix provides one Unplugin factory and host-specific entrypoints.

## Supported hosts

Node.js `>=22.18.0` is required. Each host is an optional peer dependency installed by consumers of its adapter. CLI-only use requires none of these hosts.

| Host    | Package entrypoint     | Supported range                        |
| ------- | ---------------------- | -------------------------------------- |
| Vite    | `@xova/matrix/vite`    | `^5.1.0`, `^6.0.0`, `^7.0.0`, `^8.0.0` |
| Rollup  | `@xova/matrix/rollup`  | `^2.68.0`, `^3.0.0`, `^4.0.0`          |
| Webpack | `@xova/matrix/webpack` | `^5.100.1`                             |
| esbuild | `@xova/matrix/esbuild` | `>=0.12.0 <0.29.0`                     |

Matrix resolves hosts from the consumer; Electron type preparation uses electron-vite's Vite. Framework plugins must satisfy their own host dependencies. See the [test matrix](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix) for pinned versions, combinations, and checks.

## Vite integration

```ts
import matrix from '@xova/matrix/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [matrix()],
})
```

The Vite adapter preserves the resolved envPrefix and adds the reserved MATRIX_ prefix. It reads the final Vite config.env and exposes the structured build context through virtual:matrix/runtime:

```ts
import { matrix } from 'virtual:matrix/runtime'

matrix.environment
matrix.product.name
matrix.product.appId
matrix.config.apiBase

matrix.isDevelopment
matrix.isProduction
matrix.isTest
```

The mode flags are derived from Matrix's resolved `nodeEnv` (`development`, `production`, or `test`). They are build-time snapshot values; use `matrix.target` for Matrix-specific targets such as `dev`, `build`, `dist`, and `preview`.

The same factory is available from @xova/matrix/rollup, @xova/matrix/webpack, and @xova/matrix/esbuild. The virtual module is a build-time snapshot, not a deployment-time runtime configuration system. Only variables already exposed by the host prefixes are mapped into matrix.config.

## Immutable snapshots and tree shaking

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

## Electron scopes

For multiple Electron configs, assign a scope to each build so main, preload, and renderer do not overwrite one another:

```ts
import matrix from '@xova/matrix/vite'
import { defineConfig } from 'electron-vite'

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

electron-vite must support the selected Vite version. Type preparation and real Electron application acceptance are separate checks; see the [test matrix](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix) for their versions and scope.

## Type preparation

Run `matrix prepare` to generate runtime declarations without running business targets. Product selection chooses affected projects, not the products included in each shared contract: each project + scope includes all referring products and variants in the selected `--env`. Projects with equal or overlapping physical roots are collected together. Other environments are not scanned. Scope stays in the build plugin configuration.

- Discovery checks the project root only: `electron.vite.config.*` takes priority over `vite.config.*`. Multiple matching files require an explicit choice. Set `projects.desktop.configFile`, for example `'config/electron.vite.config.ts'`, to choose a supported JS/TS config basename relative to the project root. Missing, unsupported, or failing explicit configs are errors. This setting controls type collection, not target commands.
- The locally installed Vite/electron-vite resolves real configuration hooks, `root`, `envDir`, `envPrefix`, `scope`, and `types`. Each product/variant is evaluated in isolated processes for both canonical contexts: `MATRIX_TARGET=dev`, `command=serve`, `NODE_ENV=development`; and `MATRIX_TARGET=build`, `command=build`, `NODE_ENV=production`. Configured dev/build `nodeEnv` overrides are respected; `mode` remains the selected Matrix environment. Electron main/preload use their normal development-time build hooks. Product identity and version follow execution-plan resolution, including suffixes and overrides.
- `matrix dev` and `matrix build` collect once per affected project, after its preparation commands and before its target starts. Subsequent Vite/electron-vite plugins use the complete contract rather than replacing it with active-product-only types. Configuration code and hooks execute for every referring product/variant and both contexts, adding startup work; this is not a side-effect-free static scan. Each host evaluation has a 30-second timeout. Collection does not start Electron, a dev server, or a bundle build.
- **Output boundary:** coordinated prepare/dev/build require the resolved host root and declaration output to stay within `project.root`; nested host roots and internal custom outputs are supported. Symlinks are resolved, including existing output-parent directories; escaping or dangling links fail before writes. Set `project.root` to the actual shared host directory and use `project.configFile` for configuration stored elsewhere. External custom outputs are rejected; standalone explicit type generation is unchanged.
- Public fields are merged within each project + scope. Inferred fields missing from some products, variants, or contexts become optional. Explicit schema types, defaults, optionality, and runtime validation retain their semantics; schema fields need no runtime values for declaration generation. Runtime snapshots still contain only the active product's values and respect public-prefix and main/preload/renderer boundaries.
- Collection and validation finish before writes: across all affected projects for `matrix prepare`, and per project collection group for dev/build. Duplicate scopes, conflicting outputs/prefixes, changing scope sets, and configuration failures are errors. Workspace collection/write coordination prevents competing narrower writes. A lock is recovered automatically only when its uniquely identified owner process is confirmed dead. Live or unverifiable owners are never displaced based on age; after a timeout, manually remove the reported lock only after confirming no preparation is running. Each file is replaced atomically; multiple files are not a transaction. Contracts are recomputed from current sources, never unioned with old declarations, so removed fields/products and legitimately empty configurations remove obsolete fields. Obsolete output files themselves are not automatically deleted.
- During explicit `matrix prepare`, a project without a supported host config falls back to Matrix configuration and public environment keys in `.matrix/types/matrix-runtime.d.ts`. A resolved config without a Matrix plugin also uses this fallback. Other hosts and arbitrary config basenames have no host-aware shared-contract guarantee; their host-specific prefixes and outputs cannot be discovered. Custom targets retain their existing plugin behavior and are outside the coordinated dev/build guarantee. Target command flags such as `--mode` and `--config` are not parsed for collection; if the running plugin adds uncollected fields or changes scope, prefixes, output, or schema, it fails instead of narrowing the prepared contract.

Generation emits `ImportMetaEnv` and `matrix.config` declarations without environment values. `types: false` disables generation. Explicit `matrix prepare` runs even in Vitest; automatic dev/build collection retains default Vitest suppression, with explicit `types: true` or an object opting in. Missing-context safeguards and explicit standalone opt-ins remain as described in [plugin options](../reference/plugins.md#plugin-options). Add the generated directory to each project's `tsconfig.json`:

```json
{
  "include": ["src", ".matrix/types"]
}
```
