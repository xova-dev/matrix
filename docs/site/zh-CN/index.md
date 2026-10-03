---
layout: home
title: Matrix
titleTemplate: false

hero:
  name: Matrix
  text: 多应用工作区 CLI
  tagline: 配置一次项目，按产品和环境开发、构建与交付。
  actions:
    - theme: brand
      text: 开始使用
      link: /zh-CN/getting-started
    - theme: alt
      text: 核心概念
      link: /zh-CN/concepts

features:
  - title: 项目复用
    details: 项目集中定义应用命令，产品通过绑定项目的变体组合交付物。
  - title: 环境明确
    details: 分层合并产品环境值与 dotenv，在支持的构建中提供有类型的公开配置。
  - title: 执行可控
    details: 协调就绪依赖、顺序命令、共享准备和产物交付。
---

## 选择入口

- 第一次接入：从[安装与快速开始](./getting-started.md)开始，再阅读[核心概念](./concepts.md)。
- 配置多个产品或环境：阅读[环境分层与 schema](./guides/environments.md)。
- 接入 Web 或 Electron：使用[构建工具接入指南](./guides/integrations.md)。
- CI 与打包：阅读 [CLI 参考](./reference/cli.md)及[执行与产物指南](./guides/execution.md)。
- 查询字段：打开[配置参考](./reference/configuration.md)或[插件与 runtime 参考](./reference/plugins.md)。
- 排查故障：使用[排错指南](./guides/troubleshooting.md)。

## 可运行示例

- [basic](https://github.com/xova-dev/matrix/blob/main/examples/basic/README.md)：两个项目，无框架依赖，演示就绪、环境、依赖和产物。
- [electron-web](https://github.com/xova-dev/matrix/blob/main/examples/electron-web/README.md)：两个 Web 产品复用 Electron，演示 scope 类型、项目准备和真实打包。
- [示例安装与验证边界](https://github.com/xova-dev/matrix/blob/main/examples/README.md)。

参与 Matrix 开发时，阅读[开发与验证](./contributing.md)。

Matrix 编排项目已有命令，不自动创建框架工程，也不提供部署后动态 runtime 配置。
