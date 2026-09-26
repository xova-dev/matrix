# Changelog


## v0.1.7

[compare changes](https://github.com/xova-dev/matrix/compare/v0.1.6...v0.1.7)

### 🚀 Enhancements

- **cli:** ⚠️  Streamline selection and config loading ([eaeef71](https://github.com/xova-dev/matrix/commit/eaeef71))
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

- **cli:** ⚠️  Streamline selection and config loading ([eaeef71](https://github.com/xova-dev/matrix/commit/eaeef71))

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

