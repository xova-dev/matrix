# 核心概念

Matrix 把工程目录、可运行产品和具体动作分开描述。先理解这些概念，再查阅[配置字段](reference/configuration.md)。

## 术语

| 概念    | 作用                                           |
| ------- | ---------------------------------------------- |
| Project | 应用目录及其命令                               |
| Product | 由多个变体组成的可运行交付物                   |
| Variant | 绑定到项目的产品条目                           |
| Target  | `dev`、`build`、`preview`、`test` 或自定义目标 |

## 多变体

一个产品可以运行多个项目，并为不同目标声明依赖：

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: { command: 'pnpm dev', readyWhen: { type: 'port', port: 5173 } },
        build: 'pnpm build',
      },
    },
    desktop: {
      root: './apps/desktop',
      targets: { dev: 'pnpm dev', build: 'pnpm build' },
    },
  },
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
})
```

持续运行的 `dev` 适合使用 `ready`，一次性执行的 `build` 适合使用 `completed`。

## 选择配置的归属

- 可复用目录、命令和共享准备属于 Project。
- 产品身份、发布版本及后端差异属于 Product。
- Variant 绑定项目，只声明必要的身份覆盖、目标覆盖和依赖。
- 配置环境与目标的 Node 模式是两个维度，见[环境与 schema](guides/environments.md)。

从[快速开始](getting-started.md)建立第一个产品，再用[无框架示例](https://github.com/xova-dev/matrix/blob/main/examples/basic/README.md)探索多变体。Matrix 编排已有项目命令，不自动创建框架工程。
