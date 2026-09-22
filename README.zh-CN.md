# @xova/matrix

面向多应用工作区的配置驱动 CLI。

[English](README.md) · 简体中文

只需定义一次项目，就可以按产品和环境运行开发服务、构建、预览和自定义命令。

## 特性

- 使用类型安全的配置描述项目、产品、变体和目标
- 内置 `dev`、`build`、`dist`、`preview` 和 `test` 目标
- 支持带有 `ready` 和 `completed` 条件的目标依赖
- 内置 `development`、`staging` 和 `production` 环境
- 支持 `qa`、`uat` 等自定义环境名称
- 支持 dotenv 和 Shell 覆盖的分层环境变量
- 支持交互式选择产品和环境
- 支持顺序执行多个 Target 命令，并按配置移动或压缩产物

## 安装

需要 Node.js `>=22.18.0`。

```bash
pnpm add -D @xova/matrix
```

## 快速开始

在工作区根目录创建 `matrix.config.ts`：

```ts
import { defineMatrixConfig, defineMatrixEnv } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: 'vite',
        build: { command: 'vite build', artifacts: { mode: 'archive' } },
        preview: 'vite preview',
      },
    },
  },
  products: {
    app: {
      variants: { web: 'web' },
    },
  },
})
```

在包含配置文件的目录中运行：

```bash
matrix dev app
matrix build app --env staging
matrix plan app --target preview --env production
matrix doctor
```

在交互式终端中，如果省略产品、目标或 `--env`，Matrix 会提示选择。交互式选择顺序为 Product → Variant → Target → Environment，一次运行只选择一个 Product。可以使用 `--product` 和 `--target` 显式指定选择，避免依赖位置参数顺序。

完整的可运行示例见 [`examples/basic`](examples/basic/README.md)，它不依赖具体前端框架。

## 配置

| 概念    | 作用                                           |
| ------- | ---------------------------------------------- |
| Project | 应用目录及其命令                               |
| Product | 由多个变体组成的可运行交付物                   |
| Variant | 绑定到项目的产品条目                           |
| Target  | `dev`、`build`、`preview`、`test` 或自定义目标 |

### 多变体

一个产品可以运行多个项目，并为不同目标声明依赖：

```ts
export default {
  products: {
    app: {
      variants: {
        web: 'web',
        desktop: {
          project: 'desktop',
          targets: {
            dev: { dependsOn: [{ variant: 'web', condition: 'ready' }] },
            build: { dependsOn: [{ variant: 'web', condition: 'completed' }] },
          },
        },
      },
    },
  },
}
```

持续运行的 `dev` 适合使用 `ready`，一次性执行的 `build` 适合使用 `completed`。

### 环境

所有产品共享的变量放在顶层 `env` 和 `$env`。如果不同产品复用相同项目但连接不同后端，则将产品专属变量放在产品内部：

```ts
export default defineMatrixConfig({
  projects: {},
  products: {
    app: {
      appId: 'com.example.app',
      env: { VITE_API_BASE: 'http://localhost:3000' },
      $env: defineMatrixEnv({
        staging: { VITE_API_BASE: 'https://staging-api.example.com' },
        production: { VITE_API_BASE: 'https://api.example.com' },
      }),
      variants: {},
    },
  },
})
```

`defineMatrixEnv()` 是 c12 兼容的 `$env.<environment>.env` 写法的语法糖，底层结构仍然保持不变，也继续支持直接使用原始写法。

普通应用变量的覆盖优先级从低到高为：

```text
global env/$env < product env/$env < .env layers < process.env
```

产品 identity override 会先从合并后的环境变量中解析，然后再应用 suffix：

```text
product identity < variant identity < 合并后的 identity override < environment suffix
```

`MATRIX_PRODUCT_NAME`、`MATRIX_PRODUCT_SLUG` 和 `MATRIX_PRODUCT_APP_ID` 可以通过环境变量提供 identity override。包含 suffix 的最终值会同时写入任务元数据和对应的 `MATRIX_PRODUCT_*` 变量。`MATRIX_PRODUCT_ID`、`MATRIX_PRODUCT_KEY`、执行上下文变量和 `NODE_ENV` 由 Matrix 生成，不能被环境变量覆盖。

Matrix 会向每个子进程注入以下执行上下文变量：

```text
MATRIX_ENV_NAME
MATRIX_TARGET
MATRIX_PRODUCT_KEY
MATRIX_PRODUCT_ID
MATRIX_PRODUCT_NAME
MATRIX_PRODUCT_SLUG
MATRIX_PRODUCT_APP_ID
MATRIX_VARIANT
MATRIX_PROJECT
MATRIX_NODE_ENV
NODE_ENV
```

`MATRIX_ENV_NAME` 是当前选择的 Matrix 配置环境，可以是 `staging`、`qa` 等自定义名称。`NODE_ENV` 表示目标进程的运行模式：`dev` 使用 `development`，`test` 使用 `test`，`build` 和 `preview` 使用 `production`。`MATRIX_NODE_ENV` 是同一个生成值的 `MATRIX_` 前缀版本，用于让 Vite 的前缀过滤 `config.env` 将它带入构建期 runtime module。因此 staging 构建通常会同时得到 `MATRIX_ENV_NAME=staging`、`MATRIX_NODE_ENV=production` 和 `NODE_ENV=production`。只有最终解析出的产品 identity 配置了 `appId` 时，才会注入 `MATRIX_PRODUCT_APP_ID`；环境 suffix 会在导出前生效。

产品级环境变量会为每个产品独立解析。这样多个产品可以复用同一个 Desktop 项目，同时连接不同的 Web 变体或服务。

支持自定义环境名称。使用相同的 helper 定义，并在 CLI 中显式传入环境名：

```ts
export default defineMatrixConfig({
  $env: defineMatrixEnv({
    qa: {
      VITE_API_BASE: 'https://qa-api.example.com',
    },
  }),
  projects: {},
  products: {},
})
```

```bash
matrix build app --env qa
matrix plan app --target preview --env qa
```

自定义环境可以通过 `--env` 使用。交互式运行时，Matrix 会将顶层和产品级 `$env` 中声明的环境名加入选择器。

dotenv 文件按 `.env`、`.env.local`、`.env.<environment>` 和 `.env.<environment>.local` 加载。Matrix 会将 `VITE_*`、`NUXT_*` 等变量传递给子进程，应用框架继续负责自己的运行时配置。

### 构建工具接入

Matrix 提供统一的 Unplugin 工厂，以及各构建工具的入口。

    import matrix from '@xova/matrix/vite'

    export default defineConfig({
      plugins: [matrix()],
    })

Vite 适配器会保留最终解析出的 envPrefix，并自动加入 Matrix 保留的 MATRIX_ 前缀。它读取 Vite 最终的 config.env，通过 virtual:matrix/runtime 提供结构化构建上下文：

    import { matrix } from 'virtual:matrix/runtime'

    matrix.environment
    matrix.product.name
    matrix.product.appId
    matrix.config.apiBase

    matrix.isDevelopment
    matrix.isProduction
    matrix.isTest

这些模式标记由 Matrix 解析后的 `nodeEnv`（`development`、`production` 或 `test`）生成，是构建时快照值。`dev`、`build`、`dist`、`preview` 等 Matrix 专属目标仍应通过 `matrix.target` 判断。

同一套工厂也可以通过 @xova/matrix/rollup、@xova/matrix/webpack 和 @xova/matrix/esbuild 使用。虚拟模块是构建时快照，不是部署后可变的 runtime config；只有宿主构建工具已通过前缀暴露的变量，才会进入 matrix.config。

Electron 多配置时为每个构建指定 scope，避免 main、preload、renderer 互相覆盖：

```ts
export default defineConfig({
  main: {
    plugins: [matrix({ scope: 'main' })],
  },
  preload: {
    plugins: [matrix({ scope: 'preload' })],
  },
})
```

分别使用 `virtual:matrix/runtime/main` 和 `virtual:matrix/runtime/preload`。对应类型文件会生成到 `.matrix/types/matrix-runtime-main.d.ts` 和 `.matrix/types/matrix-runtime-preload.d.ts`。

运行一次 `matrix prepare` 可生成项目级声明文件 `.matrix/types/matrix-runtime.d.ts`。它会根据 `VITE_*`（以及配置的其他公开前缀）生成 `ImportMetaEnv` 和 `matrix.config` 的键类型，不会写入环境变量的实际值。构建插件默认也会在解析最终 `envPrefix` 后生成对应类型；可通过 `types: false` 关闭。将 `.matrix/types` 加入 `tsconfig.json` 的 `include` 即可获得类型提示：

```json
{
  "include": ["src", ".matrix/types"]
}
```

## 目标和默认值

内置目标的默认值如下：

| 目标      | 环境          | 是否持续运行 |
| --------- | ------------- | ------------ |
| `dev`     | `development` | 是           |
| `build`   | `production`  | 否           |
| `dist`    | `production`  | 否           |
| `preview` | `production`  | 是           |
| `test`    | `development` | 否           |

自定义目标默认不会持续运行，未指定 `--env` 时使用 `development`。内置目标的运行模式为：`dev` 使用 `development`，`test` 使用 `test`，`build`、`dist` 和 `preview` 使用 `production`。自定义目标也可以将 `nodeEnv` 配置为 `development`、`production` 或 `test`。项目默认使用当前目录，目标输出目录默认为 `dist`，产物根目录默认为 `artifacts`。Target 可以使用字符串数组顺序执行多个命令，例如 `release: ['pnpm build', 'pnpm package']`。产物默认使用 `move` 模式，归档格式默认为 ZIP；需要归档时只需将 `artifacts.mode` 设置为 `archive` 或 `both`。启用产物交付时，`artifacts.clean` 默认为 `true`，会在每个非持续 Target 执行前清理输出目录，确保产物只包含本次执行的输出。`archive` 模式会保留本次输出目录，`move` 和 `both` 会将其移动到产物目录。产物命名为 `<variant>-<version>-<YYYYMMDD-HHmmss>`，默认按 Product、Environment、Variant 保留最近 5 个 ArtifactSet。

交互式运行会先选择 Variant，再选择 Target。Target 选项来自已选 Variant 共同支持的目标；非交互式运行可以使用 `--variant` 提前指定执行范围。

配置中的任意目标都可以通过 CLI 调用。常见的自定义目标包括 `test`、`lint` 和 `e2e`。

## 命令

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

## 开发

依赖版本统一维护在 `pnpm-workspace.yaml` 的 pnpm catalog 中。

```bash
pnpm install
pnpm check
pnpm lint:fix
```

`pnpm lint:fix` 通过 ESLint 格式化 JavaScript、TypeScript 和 Markdown。`pnpm check` 会依次执行 lint、类型检查、测试和生产构建。

## 许可证

[MIT](LICENSE)
