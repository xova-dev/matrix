# 双 Web / 共享 Electron 示例

这是一个真实消费项目：两个独立 Vite 页面、一个使用 electron-vite 构建 main/preload 的共享 Electron 工程、两个 Matrix Product。保留 `../basic` 作为无框架入门示例，本例负责框架集成与跨平台验收。

| Product | Web 项目  | Desktop 项目 | 应用标识         |
| ------- | --------- | ------------ | ---------------- |
| alpha   | web-alpha | desktop      | dev.matrix.alpha |
| beta    | web-beta  | desktop      | dev.matrix.beta  |

Web 页面分别具有固定的 Alpha/Beta 页面标识，并显示真实 `virtual:matrix/runtime`。Electron main 使用 `virtual:matrix/runtime/main`，sandbox preload 使用 `virtual:matrix/runtime/preload`，通过 contextBridge 向页面提供验收快照。共享 Electron 通过配置选择开发地址或构建资源，不在应用代码里按产品写分支。

electron-vite 5.0.0 的 peer 范围为 Vite 5–7，因此本例锁定 Vite 7.3.6；Matrix 核心的 Vite 8 集成测试仍保留。main/preload 分别使用 electron-vite 默认的 `MAIN_VITE_` / `PRELOAD_VITE_` 前缀，两者也能访问 `VITE_`；独立 Web 构建只能访问 `VITE_`。

## 本地运行

从 Matrix 仓库根目录执行（Node 24）：

```bash
pnpm example:electron-web
cd examples/electron-web
pnpm run check:types
pnpm run dev:alpha
# 或 pnpm run dev:beta；用 Ctrl+C 停止后再执行其他命令
```

构建两个产品时顺序执行：

```bash
pnpm run build:alpha
pnpm run build:beta
pnpm run check:types
```

首次使用先在仓库根目录执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。本例通过 `@xova/matrix: workspace:*` 使用本地包的公开入口，没有源码 alias；修改 Matrix 后需要重新构建。根级 `pnpm example:electron-web` 只负责准备项目，不再打包或安装 tarball。

本例与 basic 共用根级 pnpm 锁文件；框架版本仍在本例独立声明，不跟随核心测试的 Vite 版本，也不加入 Matrix 的运行时依赖。

首次准备会下载 Electron 二进制，需要网络。后续复用 Electron 自身的下载缓存。Desktop 的 `project.prepare` 只安装运行环境，并在 `.prepared` 记录每次调用；Web 的 dist 在 Desktop 消费前保留，桌面产物通过 Matrix 移至 `artifacts/<product>/<environment>`。

默认开发端口为 Alpha 5410、Beta 5420，可用 `EXAMPLE_ALPHA_PORT` 和 `EXAMPLE_BETA_PORT` 覆盖。两产品应顺序运行，不在本例中承诺共享桌面目录的并发构建。

## 完整验收

在仓库根目录运行：

```bash
pnpm test:electron-web
```

它在仓库外、带空格路径的临时消费项目中安装当前 tarball，结束后删除临时目录。从根级 pnpm 锁文件保留依赖版本、完整性和 peer snapshots，只把 Matrix workspace 链接替换为 tarball，然后执行 `pnpm install --frozen-lockfile --ignore-scripts`，不重新解析框架版本。临时项目沿用仓库的安全策略和精确例外，不借用源码或仓库的 node_modules。验收执行：

1. `matrix prepare`：两个产品共用 Desktop 时准备命令只运行一次；读取真实 Vite/electron-vite 配置，生成两个 Web 项目及 main/preload 的 runtime 类型，并在没有任何构建产物时完成 TypeScript 检查。
2. Alpha/Beta 开发启动：electron-vite 实际编译 main/preload，Desktop 等待对应 Web 就绪，真实 Chromium 页面及 preload bridge 校验三端 runtime，随后自动退出；检查未启动另一 Web 且相关进程结束。
3. 同一工作区依次构建 `alpha/staging → beta/production → alpha/production`。
4. 每次构建后启动生成的 unpacked 应用，检查三端产品身份、环境、API、布尔值和数字；两个 scope 的同名 `scopeValue` 分别为字符串和数字，并检查专属字段不串端。故意注入错误的宿主环境，确认打包资源不被后续环境污染。
5. 每次调用检查共享项目只准备一次，不能用跨调用缓存掩盖配置切换问题。
6. 每次开发启动或构建后，用 TypeScript 和真实生成声明检查 main/preload，关闭 `skipLibCheck`，不使用虚拟模块 paths 补丁。两份模块声明同时加载时应正确区分字段类型。

`check:config` 独立检查 `matrix.config.ts`；`check:types` 再检查 main/preload 的实际生成声明。首次运行只需 `pnpm run prepare:projects`，不必启动开发或构建。验收专用的字段隔离、标量类型与只读反例探针位于 `acceptance/check-types.mjs`。scope 仍仅定义在 `electron.vite.config.ts` 中；该宿主配置由真实 electron-vite 构建验证，不混用根级 Vite 8 与本例 Vite 7 的插件类型做独立 tsc 检查。prepare 会执行配置代码和配置钩子，但不会启动 Electron 或开发服务器。

`matrix.config.ts` 显式列出两个产品及其差异，不通过工厂按产品名推导配置。通用布尔默认值放在根级 schema，产品值放在产品 `env`，环境差异放在 `$env`。普通构建和启动脚本位于 `scripts/` 与 Desktop 目录；验收编排、类型探针和应用报告采集位于 `acceptance/`。不要在已有构建产物的本地工作区直接运行 `verify`：它要求干净的临时消费项目，应使用根级 `pnpm test:electron-web`。

应用自检通过 `EXAMPLE_SMOKE_OUTPUT` 启用：窗口隐藏，但页面确实由 Electron 加载并执行。普通启动仍显示窗口。验收使用 electron-builder 的 dir 目标，不制作安装器、不发布、不使用分发签名证书。

Linux 的图形验收需要显示服务器，CI 使用 Xvfb。所有平台的自检启动（开发态和打包后）均在启动命令中传入 `--no-sandbox`，不验证沙箱配置；普通手动启动不传该参数，保留 sandbox。窗口始终启用 context isolation，禁用 node integration。API 地址是示例数据，不会发起外部 API 请求。

## CI 边界

- 三平台 × Node 22.18.0 / 24.x：运行 Matrix 核心测试与安装包 smoke。
- Node 24 的三个平台额外执行本例的真实开发、构建和启动验收。
- POSIX 的信号回调／超时强杀测试只在 macOS/Linux 运行；Windows 保留取消、进程终止、后续任务不执行等平台自身可观察结果的测试。
- 本例不验证安装器、自动更新、签名／公证、移动端或多产品并行打包。GitHub runner 的实际结果才是该平台验收依据。
