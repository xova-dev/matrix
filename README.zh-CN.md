# @xova/matrix

面向多应用工作区的配置驱动 CLI。

[English](README.md) · 简体中文

只需定义一次项目，就可以按产品和环境运行开发服务、构建、预览和自定义命令。

## 特性

- 使用类型安全的配置描述项目、产品、变体和目标
- 内置 `dev`、`build` 和 `preview` 目标
- 支持带有 `ready` 和 `completed` 条件的目标依赖
- 内置 `development`、`staging` 和 `production` 环境
- 支持 `qa`、`uat` 等自定义环境名称
- 支持 dotenv 和 Shell 覆盖的分层环境变量
- 支持交互式选择产品和环境
- 支持将构建结果归档到 `artifacts`

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
        build: { command: 'vite build', archive: true },
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

在交互式终端中，如果省略产品、目标或 `--env`，Matrix 会提示选择。一次交互运行只选择一个 Product。

完整的可运行示例见 [`examples/basic`](examples/basic/README.md)，它不依赖具体前端框架。

## 配置

| 概念    | 作用                                   |
| ------- | -------------------------------------- |
| Project | 应用目录及其命令                       |
| Product | 由多个变体组成的可运行交付物           |
| Variant | 绑定到项目的产品条目                   |
| Target  | `dev`、`build`、`preview` 或自定义目标 |

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

变量覆盖优先级从低到高为：

```text
global env/$env < product env/$env < .env layers < process.env < MATRIX_*
```

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

## 目标和默认值

内置目标的默认值如下：

| 目标      | 环境          | 是否持续运行 |
| --------- | ------------- | ------------ |
| `dev`     | `development` | 是           |
| `build`   | `production`  | 否           |
| `preview` | `production`  | 是           |

自定义目标默认不会持续运行，未指定 `--env` 时使用 `development`。项目默认使用当前目录，目标输出目录默认为 `dist`，归档输出目录默认为 `artifacts`。归档默认关闭，只允许配置在 build 目标上，启用后默认使用 zip 格式。配置了归档但输出目录不存在时，构建会失败。

交互式 Target 选项来自当前 Product 的 Variant 共同支持的目标。可以先使用 `--variant` 缩小执行范围，再计算可用 Target。

配置中的任意目标都可以通过 CLI 调用。常见的自定义目标包括 `test`、`lint` 和 `e2e`。

## 命令

```text
matrix [target] [product] [--variant name] [--env <environment>]
matrix dev [product]
matrix build [product] [--env <environment>] [--archive]
matrix preview [product] [--env <environment>]
matrix plan [product] [--target <target>] [--env <environment>]
matrix doctor
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
