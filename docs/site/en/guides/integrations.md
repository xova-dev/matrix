# Build tool integration

Matrix provides one Unplugin factory and host-specific entrypoints.

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

## Type preparation

Run `matrix prepare` before starting development to generate runtime declarations for the selected products. Scope stays in the build plugin configuration; it does not need to be repeated in `matrix.config`.

- By default, preparation checks files directly in the project root only: `electron.vite.config.*` takes priority over `vite.config.*`. It never searches subdirectories or parent directories. Multiple files matching the selected rule require an explicit choice. The locally installed host resolves the real configuration, including plugin hooks, `root`, `envDir`, `envPrefix`, `scope`, and `types` options. Electron main/preload declarations are generated separately, without starting Electron, a dev server, or a bundle build.
- Set `projects.desktop.configFile`, for example `'config/electron.vite.config.ts'`, to select a file relative to that project's root. This overrides automatic discovery; the basename must still match a supported rule (`electron.vite.config.*` or `vite.config.*`, with a JS/TS module extension). Missing, unsupported, or failing explicit configs are errors, never a reason to fall back. `configFile` only controls preparation and does not modify target commands; no separate host setting is needed.
- Preparation resolves the development configuration (`serve`; Electron main/preload use their normal development-time `build` configuration hooks), with `NODE_ENV=development` and `mode` set to the Matrix `--env` selection. Each product/variant is evaluated in an isolated process with `MATRIX_TARGET=prepare` and its product key, project, and variant. Product identity (ID/name/slug/appId, including suffixes and overrides) and version use the same resolution rules as execution plans; a missing package version is allowed when no version is configured. This is not a production build context; keep scope and type contracts independent of the selected product and target.
- Shared projects merge the selected products' public field names. Schema-declared fields do not need runtime values to generate their types. Duplicate scopes, conflicting outputs/prefixes, changing scope sets, and configuration failures are diagnosed before Matrix writes declarations. Preparation does execute configuration code and configuration hooks, in addition to the existing project preparation commands; it is not a side-effect-free static scan. Each host evaluation has a 30-second timeout.
- Projects with neither an explicit config nor a supported project-root config retain the generic `.matrix/types/matrix-runtime.d.ts` generation from Matrix configuration and public environment keys. Other hosts and arbitrary config basenames are not supported yet. A successfully resolved config without a Matrix plugin also retains this generic generation (using Matrix settings, not host-specific prefixes or scopes); an active plugin with `types: false` disables generation. Existing stale declaration files are not automatically deleted.

Both preparation and build plugins derive `ImportMetaEnv` and `matrix.config` types without writing environment values. Build plugins continue generating the current build's declaration from its final configuration. In a Vitest environment automatic build-plugin generation is disabled by default; `types: true` or `types: { output: '...' }` explicitly enables it. Explicit `matrix prepare` generates types regardless of Vitest, but honors `types: false`. Add the generated type directory to each project's `tsconfig.json`:

```json
{
  "include": ["src", ".matrix/types"]
}
```

See the [plugin and runtime reference](../reference/plugins.md) for adapter options, virtual module names, and fields.
