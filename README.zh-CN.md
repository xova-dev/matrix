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

<!-- #region installation -->

需要 Node.js `>=22.18.0`。

```bash
pnpm add -D @xova/matrix
```

<!-- #endregion installation -->

精简 Linux 镜像还需要系统 `ps` 命令；平台要求见[进程关闭](docs/site/zh-CN/guides/execution.md#进程关闭)。

## 快速开始

<!-- #region quick-start -->

在工作区根目录创建 `matrix.config.ts`：

```ts
import { defineMatrixConfig } from '@xova/matrix'

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
      version: '1.0.0',
      variants: { web: 'web' },
    },
  },
})
```

在包含配置文件的目录中运行：

```bash
pnpm exec matrix dev app
pnpm exec matrix build app --env staging
pnpm exec matrix plan app --target preview --env production
pnpm exec matrix doctor
```

以上假设 Web 项目已安装 Vite 并能独立构建。显式产品版本让归档不依赖项目 `package.json` 的版本；`archive` 保留 Web 输出，便于后续 preview。`dev` 是持续服务，使用 `Ctrl+C` 停止后再执行其他命令。运行 `pnpm exec matrix` 可进入交互向导，完整命令则直接执行。

<!-- #endregion quick-start -->

## 文档

[文档导航](docs/site/zh-CN/index.md)提供按主题的阅读路径和完整参考：

- [核心概念](docs/site/zh-CN/concepts.md)：项目、产品、变体与目标。
- [配置参考](docs/site/zh-CN/reference/configuration.md)：字段、默认值、覆盖、就绪、依赖、身份与版本。
- [环境与 schema](docs/site/zh-CN/guides/environments.md)：优先级、dotenv 和公开值类型。
- [构建工具接入](docs/site/zh-CN/guides/integrations.md)：Vite/Rollup/Webpack/esbuild、runtime 快照、Electron scope 与类型。
- [插件与 runtime 参考](docs/site/zh-CN/reference/plugins.md)：适配器选项与公开 runtime 字段。
- [执行与产物](docs/site/zh-CN/guides/execution.md)：目标默认值、准备、进程关闭与产物交付。
- [CLI 参考](docs/site/zh-CN/reference/cli.md)与[排错指南](docs/site/zh-CN/guides/troubleshooting.md)。

## 示例

- [basic](examples/basic/README.md)：无框架依赖的双项目开发与构建入门。
- [electron-web](examples/electron-web/README.md)：两个 Web 产品复用真实 Electron 项目。
- [示例安装与验证边界](examples/README.md)。

## 边界

- Matrix 编排项目自己的命令，不安装应用框架，也不自动提供未声明的目标。
- 虚拟 runtime 是不可变的构建期快照，不是部署后动态配置。
- `matrix plan` 可能包含敏感值，公开分享前需检查。

## 开发

仓库环境、质量检查、CI 与验收边界见[开发与验证](docs/site/zh-CN/contributing.md)。

## 许可证

[MIT](LICENSE)
