# Changelog

## [0.4.1](https://github.com/xova-dev/matrix/compare/v0.4.0...v0.4.1) (2026-11-03)

### Highlights and migration notes

- Host scripts may add environment variables after type preparation without changing the prepared Matrix public contract. Late additions remain available through host APIs but do not expand `matrix.config` or generated types; declare late-populated public fields in `envSchema` before preparation.
- Schema validation, reserved-field protection and public-name conflict checks remain enforced. Shared declarations continue to use the active product's values, including legacy untyped aliases.
- After upgrading, rerun `matrix prepare`. Temporary resolved-env filters used solely to work around the 0.4.0 contract error can be removed. Fields already present during preparation still follow the configured public prefixes; this release does not introduce a host-specific field blacklist.

### Bug Fixes

- **env:** tolerate host additions within prepared public contracts ([89813fc](https://github.com/xova-dev/matrix/commit/89813fc23c7107c9ae6038e8ceea66517557c7e7))

### Performance Improvements

- **test:** separate tarball acceptance from compatibility checks ([b2194de](https://github.com/xova-dev/matrix/commit/b2194de0b2f8d8aa8f9fcf98cb2762e8c0fa8beb))

## [0.4.0](https://github.com/xova-dev/matrix/compare/v0.3.0...v0.4.0) (2026-11-02)

### Highlights and migration notes

- Add the optional `@xova/matrix/nuxt` Module for Nuxt's Vite builder (`^4.0.3`), including SSR, SPA and shared public snapshots. Direct Nitro imports support the `node-server` preset and local development, not other deployment presets.
- Choose native host integration with `project.typegen: false`, or retain Matrix virtual modules and shared types for mixed integration. Existing projects keep their current behavior by default. Project `typegen` and adapter/Module `types` are separate controls; runtime-only mixed Nuxt requires both to be disabled.
- Nuxt mixed integration exposes `VITE_` and `NUXT_PUBLIC_` business variables by default and rejects conflicting field aliases. Virtual-module values are public build-time snapshots, not private or deployment-time configuration; use native Nuxt `runtimeConfig` for those needs.
- Configuration discovery supports standard host filenames and explicit paths, with `configHost` needed only for ambiguous custom names. Nuxt retains native Layer loading, including package and remote Layers. Working directories are validated before execution.
- See the [English integration guide](https://github.com/xova-dev/matrix/blob/v0.4.0/docs/site/en/guides/integrations.md) or [Chinese integration guide](https://github.com/xova-dev/matrix/blob/v0.4.0/docs/site/zh-CN/guides/integrations.md) for setup, type ownership and deployment boundaries.

### Features

- **ci:** integrate pinned xova project workflows ([8c29bf3](https://github.com/xova-dev/matrix/commit/8c29bf3762ef50971c366b67036b7456d8811891))
- **ci:** unify code and docs checks with shared caches ([e5f5716](https://github.com/xova-dev/matrix/commit/e5f57168a9d361c569ecc49a089637163f2fd886))
- **integrations:** support native hosts and mixed Nuxt ([5375906](https://github.com/xova-dev/matrix/commit/53759064966007ac3d816232268adae79d1f1732))

### Bug Fixes

- **ci:** restore complete frozen dependency snapshots ([76466ec](https://github.com/xova-dev/matrix/commit/76466ecb887aabcd2def782eab053e345eeb779c))
- **ci:** reuse dependency caches for temporary consumers ([e458c53](https://github.com/xova-dev/matrix/commit/e458c5353ac23bcd4f4245e548368014b2cb47fb))
- **execution:** validate working directories and streamline Nuxt checks ([993d8ef](https://github.com/xova-dev/matrix/commit/993d8ef2e27d566107e378e6e8517901ce497768))
- **scripts:** reject abnormal process outcomes before classification ([18653f3](https://github.com/xova-dev/matrix/commit/18653f300b5f622c247699482e888e136ded2ab9))
- **test:** bound Nuxt service lifecycle and preserve cleanup failures ([00babe6](https://github.com/xova-dev/matrix/commit/00babe6b8d22ebc10ae04edd10dadac3a231fa61))
- **test:** normalize Windows paths and tier Nuxt checks ([9b147f1](https://github.com/xova-dev/matrix/commit/9b147f1250a9974b3152b217d9a370cfcf22f9cb))
- **test:** unify process ownership and bounded fixture cleanup ([ad725a7](https://github.com/xova-dev/matrix/commit/ad725a76fe4a062ccf4db57e4347ffb2003c67e0))

### Performance Improvements

- **ci:** focus platform checks on Matrix contracts ([a4f8c9f](https://github.com/xova-dev/matrix/commit/a4f8c9f8503dc5e87fc5227e25a3e8cc0088ce63))
- **ci:** narrow root installation for Electron checks ([4378a46](https://github.com/xova-dev/matrix/commit/4378a4628502282ffc7657ea2d448ffa7ec424de))
- **ci:** reuse complete CI checks before publishing ([2985d43](https://github.com/xova-dev/matrix/commit/2985d435e7bdd2ab27d1f4b18c10295a605ed039))
- **test:** narrow Nuxt collision fixtures and report wall timings ([e5a458f](https://github.com/xova-dev/matrix/commit/e5a458f0ce5384371f62a0efdc1d6b76e3e94218))
- **test:** reduce compatibility matrix version sampling ([e9f7667](https://github.com/xova-dev/matrix/commit/e9f76675cdcf418f20a8aa39f717f720faf09687))

## v0.3.0

[compare changes](https://github.com/xova-dev/matrix/compare/v0.2.1...v0.3.0)

### 🚀 Enhancements

- Stabilize shared-project types across products ([#8](https://github.com/xova-dev/matrix/pull/8))

### 🩹 Fixes

- Preserve generated types without Matrix context ([fd49d50](https://github.com/xova-dev/matrix/commit/fd49d50))
- Validate host config discovery in doctor ([547f7e9](https://github.com/xova-dev/matrix/commit/547f7e9))
- Retain Electron acceptance report diagnostics ([fa3ecce](https://github.com/xova-dev/matrix/commit/fa3ecce))

### Migration notes

- Run `matrix prepare` before standalone type checks. Without Matrix CLI context, adapters now preserve existing declarations by default; `types: true` or an output object explicitly enables generation.
- Shared-project declarations include all linked products and variants in the selected environment, resolving both dev and build configurations. Inferred fields missing from some contexts become optional; configuration hooks run for both contexts.
- During shared-project collection, the resolved host root and declaration output must stay within `project.root`. Set it to the shared host directory and use `configFile` for configurations stored elsewhere.

### ✅ Tests

- Stabilize Vite fixtures and streamline typegen docs ([e740588](https://github.com/xova-dev/matrix/commit/e740588))

### 🤖 CI

- Consolidate validation and streamline releases ([a5026ea](https://github.com/xova-dev/matrix/commit/a5026ea))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.2.1

[compare changes](https://github.com/xova-dev/matrix/compare/v0.2.0...v0.2.1)

### 🩹 Fixes

- **prepare:** Resolve the Vite 5 CommonJS API correctly when generating types, including Electron contexts. ([67d4a29](https://github.com/xova-dev/matrix/commit/67d4a29))
- **compat:** Declare optional host peers, isolate consumer adapter types, and support older Rollup and esbuild APIs with published-package regression coverage. ([67d4a29](https://github.com/xova-dev/matrix/commit/67d4a29))
- **ci:** Scope runner cache variables to execution steps ([ca0534f](https://github.com/xova-dev/matrix/commit/ca0534f))

### 📖 Documentation

- Add concise project agent guidelines ([efa3f33](https://github.com/xova-dev/matrix/commit/efa3f33))

### 🤖 CI

- Streamline compatibility matrix and cache downloads ([c97e9e6](https://github.com/xova-dev/matrix/commit/c97e9e6))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.2.0

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.7...v0.2.0)

### 🚀 Enhancements

- **version:** Support product and variant release versions ([5769b75](https://github.com/xova-dev/matrix/commit/5769b75))
- **env:** Add typed environment schema validation ([fadc291](https://github.com/xova-dev/matrix/commit/fadc291))
- **doctor:** Add static workspace preflight checks ([0d8bef5](https://github.com/xova-dev/matrix/commit/0d8bef5))
- **prepare:** Generate scoped types from host configuration ([31e8de6](https://github.com/xova-dev/matrix/commit/31e8de6))
- **runtime:** Inline immutable Matrix snapshots across supported hosts ([23058ea](https://github.com/xova-dev/matrix/commit/23058ea))
- **execution:** Add final summaries and contextual failure diagnostics ([cd2dcd6](https://github.com/xova-dev/matrix/commit/cd2dcd6))

### ⚠️ Breaking Changes

- **runtime:** `matrix`, `matrix.product`, and `matrix.config` are now read-only in generated types and frozen at runtime. Direct snapshot writes fail builds with default static inlining; runtime freezing also prevents indirect mutation and applies with `inline: false`. ([23058ea](https://github.com/xova-dev/matrix/commit/23058ea))
- **migration:** Copy the relevant product/config values into application-owned mutable state instead of modifying Matrix snapshots.

### 🩹 Fixes

- **types:** Validate scoped runtimes with electron-vite ([64b8369](https://github.com/xova-dev/matrix/commit/64b8369))
- **ci:** Explicitly disable electron-winstaller install script ([a2d1be9](https://github.com/xova-dev/matrix/commit/a2d1be9))
- **paths:** Adopt pathe and normalize Windows integration boundaries ([c7e686f](https://github.com/xova-dev/matrix/commit/c7e686f))
- **paths:** Preserve native resolution and harden cleanup guards ([794e499](https://github.com/xova-dev/matrix/commit/794e499))
- **ci:** Isolate native addon smoke checks and clean up test resources ([6725b4a](https://github.com/xova-dev/matrix/commit/6725b4a))

### 💅 Refactors

- **core:** Organize modules and strengthen runtime conformance ([91cdf4e](https://github.com/xova-dev/matrix/commit/91cdf4e))
- **examples:** Adopt pnpm workspaces and clarify example workflows ([ce17d4d](https://github.com/xova-dev/matrix/commit/ce17d4d))

### 📖 Documentation

- **site:** Add bilingual docs and release-gated deployment ([5337c9f](https://github.com/xova-dev/matrix/commit/5337c9f))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.1.7

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.6...v0.1.7)

### 🚀 Enhancements

- **cli:** ⚠️ Streamline selection and config loading ([eaeef71](https://github.com/xova-dev/matrix/commit/eaeef71))
- **prepare:** Add project preparation lifecycle ([8129da9](https://github.com/xova-dev/matrix/commit/8129da9))

### 🩹 Fixes

- **vite:** Skip default type generation in Vitest ([6cd2715](https://github.com/xova-dev/matrix/commit/6cd2715))
- **exec:** Wait for child processes during shutdown ([2910db7](https://github.com/xova-dev/matrix/commit/2910db7))
- **exec:** Wait for process-tree shutdown across platforms ([a4b4f12](https://github.com/xova-dev/matrix/commit/a4b4f12))
- **examples:** Make Electron acceptance portable ([63e869e](https://github.com/xova-dev/matrix/commit/63e869e))

### ✅ Tests

- **smoke:** Isolate packaged CLI shutdown verification ([eac035d](https://github.com/xova-dev/matrix/commit/eac035d))
- **ci:** Add cross-platform multi-product acceptance ([cf410ac](https://github.com/xova-dev/matrix/commit/cf410ac))

#### ⚠️ Breaking Changes

- **cli:** ⚠️ Streamline selection and config loading ([eaeef71](https://github.com/xova-dev/matrix/commit/eaeef71))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.1.6

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.4...v0.1.6)

### 🩹 Fixes

- **runtime:** Align development flag with vite ([917367e](https://github.com/xova-dev/matrix/commit/917367e))
- **cli:** Gracefully cancel child processes ([183d03d](https://github.com/xova-dev/matrix/commit/183d03d))
- **vite:** Preserve Matrix node environment ([558d083](https://github.com/xova-dev/matrix/commit/558d083))
- **prepare:** Generate types per project ([4f00790](https://github.com/xova-dev/matrix/commit/4f00790))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.1.4

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.3...v0.1.4)

### 🚀 Enhancements

- **runtime:** Expose environment mode flags ([5693003](https://github.com/xova-dev/matrix/commit/5693003))

### 🩹 Fixes

- **types:** Protect generated declarations ([657d048](https://github.com/xova-dev/matrix/commit/657d048))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.1.3

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- **artifacts:** Clean outputs before materialization ([016d06a](https://github.com/xova-dev/matrix/commit/016d06a))
- **targets:** Add test target defaults ([b302f3d](https://github.com/xova-dev/matrix/commit/b302f3d))
- **targets:** Add dist target defaults ([61daf94](https://github.com/xova-dev/matrix/commit/61daf94))

### 🩹 Fixes

- **schema:** Accept ordered project target commands ([e988b62](https://github.com/xova-dev/matrix/commit/e988b62))

### 💅 Refactors

- **artifacts:** Remove none sentinel and harden delivery ([ee9414e](https://github.com/xova-dev/matrix/commit/ee9414e))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.1.2

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- **matrix:** Support ordered targets and artifact sets ([3eb3b10](https://github.com/xova-dev/matrix/commit/3eb3b10))
- Add scoped build runtime integration ([1605e82](https://github.com/xova-dev/matrix/commit/1605e82))

### 🩹 Fixes

- **ci:** Publish tagged releases without branch checks ([c81c901](https://github.com/xova-dev/matrix/commit/c81c901))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.1.1

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.0...v0.1.1)

### 🚀 Enhancements

- **matrix:** Export execution context env ([bc3fa29](https://github.com/xova-dev/matrix/commit/bc3fa29))

### 🩹 Fixes

- **ci:** Use available npm publish workflow ([a19e55e](https://github.com/xova-dev/matrix/commit/a19e55e))
- **matrix:** Preserve inherited process environment ([abbed38](https://github.com/xova-dev/matrix/commit/abbed38))

### 🏡 Chore

- **release:** Require clean workspace ([f8642ce](https://github.com/xova-dev/matrix/commit/f8642ce))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))

## v0.1.0

[compare changes](https://github.com/xova-dev/matrix/compare/61be30f...v0.1.0)

### 🚀 Enhancements

- Streamline CLI selection flow ([e053bb1](https://github.com/xova-dev/matrix/commit/e053bb1))

### 🩹 Fixes

- Harden archive handling ([27b9ef0](https://github.com/xova-dev/matrix/commit/27b9ef0))
- Validate execution graph in doctor ([02308bd](https://github.com/xova-dev/matrix/commit/02308bd))
- Enforce readiness deadlines ([00ce7e6](https://github.com/xova-dev/matrix/commit/00ce7e6))
- Validate CLI arguments ([8cc45d0](https://github.com/xova-dev/matrix/commit/8cc45d0))
- Use package bin in example ([17a7513](https://github.com/xova-dev/matrix/commit/17a7513))

### 🏡 Chore

- **publish:** Validate packed package before release ([22c8681](https://github.com/xova-dev/matrix/commit/22c8681))
- **release:** Add changelogen workflow ([2a75fec](https://github.com/xova-dev/matrix/commit/2a75fec))

### ✅ Tests

- Cover execution plan runtime behavior ([1fa5fee](https://github.com/xova-dev/matrix/commit/1fa5fee))

### 🤖 CI

- Add mise-managed npm publishing ([b826147](https://github.com/xova-dev/matrix/commit/b826147))

### ❤️ Contributors

- Oevery ([@oevery](https://github.com/oevery))
