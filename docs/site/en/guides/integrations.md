# Build tool integration

Matrix orchestrates products, variants, environments, tasks, processes, and artifacts. Choose **native integration** (environment variables and the host API) or **mixed integration** (explicitly install an adapter for Matrix's build snapshot and types). Both retain the host's native APIs; mixed integration does not require consuming two APIs for the same field. There is no integration-mode enum.

## Supported hosts

Node.js `>=22.18.0` is required. Each host is an optional peer dependency installed by consumers of its adapter. CLI-only use requires none of these hosts.

| Host    | Package entrypoint     | Supported range                        |
| ------- | ---------------------- | -------------------------------------- |
| Vite    | `@xova/matrix/vite`    | `^5.1.0`, `^6.0.0`, `^7.0.0`, `^8.0.0` |
| Nuxt    | `@xova/matrix/nuxt`    | `^4.0.3`; Vite SSR / SPA               |
| Rollup  | `@xova/matrix/rollup`  | `^2.68.0`, `^3.0.0`, `^4.0.0`          |
| Webpack | `@xova/matrix/webpack` | `^5.100.1`                             |
| esbuild | `@xova/matrix/esbuild` | `>=0.12.0 <0.29.0`                     |

Matrix resolves hosts from the consumer; Electron type preparation uses electron-vite's Vite. Framework plugins must satisfy their own host dependencies. See the [test matrix](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix) for pinned versions, combinations, and checks.

The isolated historical Webpack fixtures pin `schema-utils` to `4.5.0`, matching the repository lockfile, because `4.8.1` requires `webpack ^5.112.0`. Strict peer checks remain enabled. This is a test-fixture pin, not a published dependency override or a change to the supported host ranges.

## Native Vite integration

No Matrix plugin, virtual module, or declaration is required:

```ts
// matrix.config.ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: { typegen: false, targets: { dev: 'vite', build: 'vite build' } },
  },
  products: {
    app: {
      env: { VITE_API_BASE: 'https://api.example.test' },
      variants: { web: 'web' },
    },
  },
})
```

Run `matrix dev app` or `matrix build app`; application code reads `import.meta.env.VITE_API_BASE`. Use Vite's own `vite/client` types and `ImportMetaEnv` augmentation for application-specific fields. Vite owns exposure, string conversion, built-in mode flags, and build-time replacement. Only its configured public prefixes enter the client bundle; Matrix does not automatically expose `MATRIX_*` or `NUXT_*` on this path. A static Vite bundle does not read deployment environment changes after building.

`project.typegen: false` skips Matrix host discovery/loading and all Matrix type preparation, including explicit `matrix prepare`, automatic dev/build collection, generic fallback, and overlapping-project expansion. Project preparation commands still run. Omission preserves the existing mixed preparation behavior; existing consumers do not silently migrate. This option does not remove old declarations or disable a manually installed plugin's own generation: remove that plugin/import and obsolete `.matrix` references when choosing the native path. `target.prepare: false` only skips project commands and is not a substitute.

## Mixed Vite integration

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

## Native Nuxt integration

Nuxt owns its `runtimeConfig` contract, defaults, generated types, and application API. Matrix only supplies matching environment variables to native commands; no Matrix Module, Vite plugin, virtual module, or generated declaration is involved on this path. Native integration remains recommended, not mandatory, for ordinary Nuxt applications. Isolated command preparation is tested with Nuxt 4.0.3 and 4.6.3; the mixed SSR chain owns production runtimeConfig and default Nitro Node-server verification. This does not certify native SPA generation in every package run, every Nuxt minor, builder, or Nitro preset.

```ts
// nuxt.config.ts (or a shared Nuxt Layer)
export default defineNuxtConfig({
  runtimeConfig: {
    privateToken: '',
    public: { apiBase: '' },
  },
})
```

```ts
// matrix.config.ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      typegen: false,
      targets: { dev: 'nuxt dev', build: 'nuxt build', generate: 'nuxt generate' },
    },
  },
  products: {
    app: {
      env: { NUXT_PUBLIC_API_BASE: 'https://api.example.test' },
      variants: { web: 'web' },
    },
  },
})
```

Run native targets through Matrix during development/build: `matrix dev app`, `matrix build app`, or `matrix generate app`. Keep Nuxt's own `nuxt prepare` / `nuxt typecheck` in the application's normal workflow when needed. `matrix prepare` still runs `project.prepare` but does not load Nuxt or generate any Matrix types for this project. `configFile` is a Matrix mixed-typegen setting, not how Nuxt commands select their config; leave it out here. Matrix never infers the framework or reads target command flags.

Application components use only the native API:

```ts
const config = useRuntimeConfig()
const apiBase = config.public.apiBase
```

Nitro server handlers use `useRuntimeConfig(event)`; only `public` fields are exposed to the client. The declaration `public.apiBase` matches **`NUXT_PUBLIC_API_BASE`**, and `privateToken` matches **`NUXT_PRIVATE_TOKEN`**. Declare fields/defaults once in Nuxt config or a Layer, rather than copying `runtimeConfig` into Matrix or introducing a second read API. The `NUXT_*` prefix is not automatically a public Matrix prefix. A shared business package should receive the values or callbacks it needs as parameters; it need not depend on either framework API.

Keep private production secrets out of build-time defaults and product build inputs. Build the Node server with empty/non-secret defaults, then start the same `.output/server/index.mjs` directly (without Matrix) with deployment-provided `NUXT_PRIVATE_TOKEN` and `NUXT_PUBLIC_API_BASE`. Nuxt/Nitro applies matching overrides at server startup; different deployment values do not require rebuilding the artifact. Do not use differently named `process.env` variables as runtimeConfig defaults to emulate this mapping. Never return private fields from server handlers.

For a static SPA (`ssr: false`, `nuxt generate`), public values are baked into the generated payload/assets. Hosting the same files with different environment variables does **not** override them; rebuild per product/environment or design an explicit external configuration service. Build switches such as SSR, presets, and feature elimination belong to build configuration, not mutable runtimeConfig fields. Nuxt retains its own build modes and env handling; the Matrix environment selects Matrix inputs, not a replacement Nuxt mode system.

## Mixed Nuxt SSR and SPA integration

For multiple products sharing one Nuxt application, explicitly install the optional Module:

```ts
// nuxt.config.ts (also supported in a shared Layer)
export default defineNuxtConfig({
  modules: ['@xova/matrix/nuxt'], // SSR by default; ssr: false also supports SPA
  nitro: { preset: 'node-server' },
})
```

Leave `project.typegen` enabled (omit it); targets remain native commands such as `dev: 'nuxt dev'` and `build: 'nuxt build'` (or `nuxt generate` for a static SPA). Run `matrix dev app` / `matrix build app`. The Module installs the virtual runtime and references its types; do not also install Matrix's Vite plugin. Layer/application Module duplication uses Nuxt's native deduplication.

```ts
import { matrix } from 'virtual:matrix/runtime'

const apiBase = matrix.config.apiBase // NUXT_PUBLIC_API_BASE: build-time snapshot
const productName = matrix.product.name
```

Alternatively, register `modules: ['@xova/matrix/nuxt']` and put options in the typed top-level `matrix: { ... }` key. Layer/application options follow Nuxt's normal precedence and deduplication; do not repeat conflicting inline options.

### Public fields and options

Business fields default to **`['VITE_', 'NUXT_PUBLIC_']`**, preserving shared Vite business variables without exposing Nuxt's broad `NUXT_` prefix. This is a Nuxt-only default; the plain Vite adapter does not add `NUXT_PUBLIC_`. Matrix's existing safe product metadata remains available, while internal metadata and private variables remain excluded.

An explicit Module `envPrefix` **replaces** these business defaults: `envPrefix: 'NUXT_PUBLIC_'` excludes `VITE_`. `scope`, `inline`, and `types: { output }` follow the adapter contracts. For example, `modules: [['@xova/matrix/nuxt', { scope: 'web', envPrefix: ['NUXT_PUBLIC_', 'APP_'], types: { output: 'types/matrix.d.ts' } }]]` uses `virtual:matrix/runtime/web`. Never add private prefixes to an override.

Different public variable names must not map to the same `matrix.config` field in Nuxt, even if their values match. Type collection also rejects aliases split across products. For example, `VITE_API_BASE` and `NUXT_PUBLIC_API_BASE` both map to `matrix.config.apiBase` and fail with a diagnostic naming the keys and field, not their values. The same applies to camelCase aliases and schema-only declarations. Choose one original variable name across products, or use explicit prefixes to exclude an alias. Normal Matrix product/environment overrides of the **same** variable name remain supported. Neither prefix is automatically copied into or declared in Nuxt `runtimeConfig`; its native contract stays independent.

### Type ownership and preparation

Nuxt `rootDir` uniquely owns types even with a custom `srcDir`; the Module adds the reference to Nuxt's generated types. Preparation resolves real Nuxt dev/build client configurations, merges all linked products, and retains optional cross-product fields. It stops before starting a Vite server or compiling application code.

The client contract is authoritative: actual dev/build also resolves the server pipeline and requires identical public prefixes and snapshots, then reuses the same snapshot. Server-only public additions, removals, or values fail explicitly instead of silently widening or overwriting types; use native server configuration for private values. Nuxt preparation does not recursively run Matrix preparation. Outputs stay within `project.root`. Environment changes need a restart/rebuild; source HMR does not refresh snapshot inputs.

`project.typegen: false` disables coordinator discovery/generation, not virtual modules. For runtime-only mixed use, also explicitly set Module `types: false`; otherwise a build error prevents silently undoing that setting. `nuxt prepare` / `nuxt typecheck` can consume previously prepared types. Standalone Nuxt dev/build without Matrix context fails with a diagnostic; native applications without the Module remain unaffected.

Package verification uses a mixed SSR application with an explicit application `rootDir` and local, installed-package and controlled HTTP remote Layers at both tested Nuxt endpoints. Two product builds check client assets, SSR and direct Node Nitro startup; deployment runtimeConfig overrides do not change the Matrix snapshot or artifact. Native no-Module integration, `ssr: false`, config suffixes and explicit paths retain lightweight real preparation/typecheck/load checks rather than repeating production builds. HTTP/SSR checks do not establish browser hydration or interaction acceptance.

Every package profile keeps both Nuxt endpoints, the mixed SSR/Node deployment chain, strict Matrix contract types and explicit same-directory/outside-root/junction Layer paths. The full profile additionally checks Nuxt application types, default-discovery suffix permutations and option/collision rejections; daily/platform share the platform-sensitive core. Alias permutations also remain covered by shared runtime/type-generation tests on every CI platform. Layer selection uses one automatically prepared Matrix target before native loading, keeping Matrix context and failure-preservation checks without collecting the same contract twice.

A native reproduction on Nuxt 4.0.3 with a `.ts` root config, custom `srcDir` and object-exported remote Layer changed the default application root to the remote cache during repeated same-process config loading, without Matrix. The same reproduction retained the root on 4.6.3. The mixed package fixture explicitly sets `rootDir`; its result does not certify that affected default-root combination.

### Runtime and deployment boundaries

The Module does **not** proxy, copy, infer, or synchronize `runtimeConfig`. `useRuntimeConfig()` remains available for independently owned fields; use one authoritative API for a given field. Snapshot values are not deployment overrides. Using both APIs is optional.

SSR application imports use the same public build snapshot as client imports. SSR HTML therefore contains the selected product values before hydration. The emitted Node server starts directly without Matrix; deployment environment changes do not replace the Matrix snapshot, while independently declared native `runtimeConfig` overrides still work. Never put server secrets in Matrix public prefixes: public snapshot fields can enter HTML, client JavaScript, and payloads.

Direct imports from `server/api` and Nitro plugins are additionally supported for the **`node-server` preset** (and its local development pipeline), using the same scoped module and snapshot, without a second type owner. This is distinct from SSR application support. Other Nitro presets reject direct Matrix imports with a diagnostic; use native `runtimeConfig` there.

### Supported pipelines

Mixed integration supports the Nuxt Vite builder within the declared `^4.0.3` range, with packed 4.0.3 and 4.6.3 consumers covering SSR, static SPA, and Node Nitro, not every intermediate minor or deployment platform. Other builders and `experimental.viteEnvironmentApi` are explicitly rejected, including runtime-only use.

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

Run `matrix prepare [product]` to generate declarations without running business targets. The product selects projects; each shared project + scope includes all referring products and variants in the selected `--env`, never other environments. Mixed projects with equal or overlapping physical roots are collected together; projects with `typegen: false` never join the group. `matrix dev` and `matrix build` collect after project preparation, before starting the target.

### Configuration and compatibility

#### Automatic discovery

Discovery checks only the project root: priority is `nuxt.config.*`, `electron.vite.config.*`, then `vite.config.*`, with `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, and `.cts` extensions. Multiple matches require an explicit choice. Native projects with `typegen: false` skip discovery, including doctor's host-config check.

#### Explicit configFile and configHost

Set `projects.desktop.configFile` (for example, `'config/electron.vite.config.ts'`) relative to the project root to select an exact file. Standard filenames automatically identify the host, including explicitly selected extensionless `nuxt.config`, `electron.vite.config`, and `vite.config`; these extensionless names are not automatic discovery candidates. Only unrecognized names require `configHost: 'vite'`, `'electron-vite'`, or `'nuxt'`; for example, `{ configFile: 'build/custom.mjs', configHost: 'vite' }`.

Identifying a host does not add file-format support: the consumer's host loader/version decides whether it accepts the selected file, including extensionless configs. Matrix does not infer a host from commands or installed dependencies. A host conflicting with a standard filename, a missing file, or a failing config is an error. These settings do not change target commands; scope stays in the build plugin config.

#### Nuxt Layers

Nuxt Layers retain native `nuxt.config` discovery independently of the application's config suffix or explicit path. Nuxt resolves local, nested, installed-package, and remote Layers, merges their options and runs Modules/hooks before Matrix collects the final client Vite config. Explicit root selection does not rename each Layer's config or replace Nuxt's fetch/auth/install behavior. Install required remote-Layer dependencies in the consumer; Matrix does not provision them.

#### Output boundary and collection scope

The resolved host root and declaration output must stay within `project.root`, including through symlinks; escaping or dangling links fail before writes. To migrate, set `project.root` to the shared host directory and use `configFile` for a config stored elsewhere. Nested host roots and internal custom outputs work; external outputs are rejected. Standalone explicit generation is unchanged.

Shared collection supports standard Vite/electron-vite and mixed Nuxt SSR/SPA dev/build contexts. Custom targets and other hosts retain existing plugin behavior. Collection does not parse target command flags such as `--mode` or `--config`; an active plugin that adds uncollected fields or changes scope, prefixes, output, or schema fails rather than replacing the contract.

#### Fallback

Unless `project.typegen: false` is set, explicit `matrix prepare` falls back to Matrix settings and public environment keys in `.matrix/types/matrix-runtime.d.ts` when no supported config exists or a resolved config has no Matrix plugin. This fallback cannot discover host-specific prefixes or outputs.

### Contract behavior

- The locally installed host resolves each product/variant in both dev (`MATRIX_TARGET=dev`, `command=serve`, `NODE_ENV=development`) and build (`MATRIX_TARGET=build`, `command=build`, `NODE_ENV=production`) contexts. Configured `nodeEnv` overrides apply; Vite/electron-vite `mode` is the selected Matrix environment. Electron main/preload use normal development-time build hooks. Product identity and version follow execution-plan rules.
- Configuration code and hooks run for both contexts, adding startup work, with a 30-second timeout per evaluation. Collection itself starts no Electron process, server, or bundle build.
- Inferred public fields missing from some products, variants, or contexts become optional. Explicit schema types, defaults, optionality, and validation are unchanged; schema fields need no runtime values. Runtime values remain active-product-only, respecting public prefixes and Electron scope boundaries.
- Duplicate scopes, conflicting outputs/prefixes, changing scope sets, and configuration failures are rejected before writing: across all affected projects for `prepare`, or per collection group for dev/build. Contracts are rebuilt from current sources, so removed fields/products and empty configurations remove obsolete fields. Obsolete output files are not deleted automatically.

Declarations contain `ImportMetaEnv` and `matrix.config` types, never environment values. `types: false` disables generation. Explicit `matrix prepare` runs even in Vitest; automatic dev/build collection follows the [plugin defaults and explicit opt-ins](../reference/plugins.md#plugin-options), including Vitest suppression and missing-context safeguards. Add the generated directory to each project's `tsconfig.json`:

```json
{
  "include": ["src", ".matrix/types"]
}
```
