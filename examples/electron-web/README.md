# 双 Web / 共享 Electron 示例

这是一个真实消费项目：两个独立 Vite 页面、一个共享 Electron 工程、两个 Matrix Product。保留 `../basic` 作为无框架入门示例，本例负责框架集成与跨平台验收。

| Product | Web 项目  | Desktop 项目 | 应用标识         |
| ------- | --------- | ------------ | ---------------- |
| alpha   | web-alpha | desktop      | dev.matrix.alpha |
| beta    | web-beta  | desktop      | dev.matrix.beta  |

Web 页面分别具有固定的 Alpha/Beta 页面标识，并显示真实 `virtual:matrix/runtime`。共享 Electron 通过配置选择开发地址或构建资源，不在应用代码里按产品写分支。

## 本地运行

从 Matrix 仓库根目录执行（Node 24）：

```bash
pnpm example:electron-web
cd examples/electron-web
npm run dev:alpha
# 或 npm run dev:beta

npm run build:alpha
npm run build:beta
```

初始化命令先打包当前 Matrix，再通过 npm 安装到本例；没有源码 alias，也不从仓库外层 node_modules 偷用 Matrix。本例使用独立的 `package-lock.json` 锁定框架依赖，Matrix tarball 通过 `--no-save` 注入，不改动依赖清单或锁文件。不把这些框架加入 Matrix 的运行时依赖。

首次准备会下载 Electron 二进制，需要网络。后续复用 Electron 自身的下载缓存。Desktop 的 `project.prepare` 只安装运行环境，并在 `.prepared` 记录每次调用；Web 的 dist 在 Desktop 消费前保留，桌面产物通过 Matrix 移至 `artifacts/<product>/<environment>`。

默认开发端口为 Alpha 5410、Beta 5420，可用 `EXAMPLE_ALPHA_PORT` 和 `EXAMPLE_BETA_PORT` 覆盖。两产品应顺序运行，不在本例中承诺共享桌面目录的并发构建。

## 完整验收

在仓库根目录运行：

```bash
pnpm test:electron-web
```

它在带空格路径的临时消费项目中安装当前 tarball，结束后删除临时目录。验收执行：

1. `matrix prepare`：两个产品共用 Desktop 时只准备一次，并生成三个项目的 runtime 类型。
2. Alpha/Beta 开发启动：Desktop 等待对应 Web 就绪，真实 Chromium 页面校验 runtime，随后自动退出；检查未启动另一 Web 且相关进程结束。
3. 同一工作区依次构建 `alpha/staging → beta/production → alpha/production`。
4. 每次构建后启动生成的 unpacked 应用，检查页面、产品身份、环境和 API 配置；故意注入错误的宿主环境，确认打包资源不被后续环境污染。
5. 每次调用检查共享项目只准备一次，不能用跨调用缓存掩盖配置切换问题。

应用自检通过 `EXAMPLE_SMOKE_OUTPUT` 启用：窗口隐藏，但页面确实由 Electron 加载并执行。普通启动仍显示窗口。验收使用 electron-builder 的 dir 目标，不制作安装器、不发布、不使用分发签名证书。

Linux 的图形验收需要显示服务器，CI 使用 Xvfb。仅 Linux CI 自检会加 `--no-sandbox` 以适应受限 runner；常规应用窗口保持 context isolation、sandbox，禁用 node integration。API 地址是示例数据，不会发起外部 API 请求。

## CI 边界

- 三平台 × Node 22.18.0 / 24.x：运行 Matrix 核心测试与安装包 smoke。
- Node 24 的三个平台额外执行本例的真实开发、构建和启动验收。
- POSIX 的信号回调／超时强杀测试只在 macOS/Linux 运行；Windows 保留取消、进程终止、后续任务不执行等平台自身可观察结果的测试。
- 本例不验证安装器、自动更新、签名／公证、移动端或多产品并行打包。GitHub runner 的实际结果才是该平台验收依据。
