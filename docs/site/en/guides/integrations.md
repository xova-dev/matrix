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

The isolated historical Webpack fixtures pin `schema-utils` to `4.5.0`, matching the repository lockfile, because `4.8.1` requires `webpack ^5.112.0`. Strict peer checks remain enabled. This is a test-fixture pin, not a published dependency override or a change to the supported host ranges.

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

Run `matrix prepare [product]` to generate declarations without running business targets. The product selects projects; each shared project + scope includes all referring products and variants in the selected `--env`, never other environments. Projects with equal or overlapping physical roots are collected together. `matrix dev` and `matrix build` collect after project preparation, before starting the target.

### Configuration and compatibility

- Discovery checks only the project root: `electron.vite.config.*` takes priority over `vite.config.*`. Multiple matches require an explicit choice. Set `projects.desktop.configFile` (for example, `'config/electron.vite.config.ts'`) relative to the project root, using a supported JS/TS config basename. Missing, unsupported, or failing explicit configs are errors. This setting does not change target commands; scope stays in the build plugin config.
- **Output boundary:** the resolved host root and declaration output must stay within `project.root`, including through symlinks; escaping or dangling links fail before writes. To migrate, set `project.root` to the shared host directory and use `configFile` for a config stored elsewhere. Nested host roots and internal custom outputs work; external outputs are rejected. Standalone explicit generation is unchanged.
- Shared collection supports standard Vite/electron-vite dev/build targets. Custom targets and other hosts retain existing plugin behavior. Collection does not parse target command flags such as `--mode` or `--config`; an active plugin that adds uncollected fields or changes scope, prefixes, output, or schema fails rather than replacing the contract.
- Explicit `matrix prepare` falls back to Matrix settings and public environment keys in `.matrix/types/matrix-runtime.d.ts` when no supported config exists or a resolved config has no Matrix plugin. This fallback cannot discover host-specific prefixes or outputs.

### Contract behavior

- The locally installed host resolves each product/variant in both dev (`MATRIX_TARGET=dev`, `command=serve`, `NODE_ENV=development`) and build (`MATRIX_TARGET=build`, `command=build`, `NODE_ENV=production`) contexts. Configured `nodeEnv` overrides apply; `mode` is the selected Matrix environment. Electron main/preload use normal development-time build hooks. Product identity and version follow execution-plan rules.
- Configuration code and hooks run for both contexts, adding startup work, with a 30-second timeout per evaluation. Collection itself starts no Electron process, server, or bundle build.
- Inferred public fields missing from some products, variants, or contexts become optional. Explicit schema types, defaults, optionality, and validation are unchanged; schema fields need no runtime values. Runtime values remain active-product-only, respecting public prefixes and Electron scope boundaries.
- Duplicate scopes, conflicting outputs/prefixes, changing scope sets, and configuration failures are rejected before writing: across all affected projects for `prepare`, or per collection group for dev/build. Contracts are rebuilt from current sources, so removed fields/products and empty configurations remove obsolete fields. Obsolete output files are not deleted automatically.

Declarations contain `ImportMetaEnv` and `matrix.config` types, never environment values. `types: false` disables generation. Explicit `matrix prepare` runs even in Vitest; automatic dev/build collection follows the [plugin defaults and explicit opt-ins](../reference/plugins.md#plugin-options), including Vitest suppression and missing-context safeguards. Add the generated directory to each project's `tsconfig.json`:

```json
{
  "include": ["src", ".matrix/types"]
}
```
