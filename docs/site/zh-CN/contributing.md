# 开发与验证

示例分为轻量的 `examples/basic` 和真实的 [双 Web / 共享 Electron 示例](https://github.com/xova-dev/matrix/blob/main/examples/electron-web/README.md)，统一加入 pnpm workspace；安装方式和验证边界见 [示例导航](https://github.com/xova-dev/matrix/blob/main/examples/README.md)。根目录执行 `pnpm install --frozen-lockfile`、`pnpm build` 后，可用 `pnpm example:basic` 打开入门向导，或用 `pnpm example:electron-web` 准备 Electron 项目。`pnpm check:examples` 检查两个 Matrix 配置；`pnpm test:electron-web` 则在仓库外、依赖锁定的临时项目中独立安装本次 tarball，验收开发、构建和真实应用启动。

CI 在 PR、main push 和手动触发时运行。OS / Node 组合、发布包宿主版本、Electron 验收与平台跳过项统一见[测试矩阵](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix)。

开发依赖版本维护在 `pnpm-workspace.yaml` 的 pnpm catalog 中；发布包消费端测试版本与类型检查基线维护在 `scripts/compatibility-matrix.json` 中。

```bash
pnpm install
pnpm check
pnpm lint:fix
```

`pnpm lint:fix` 通过 ESLint 格式化 JavaScript、TypeScript 和 Markdown。`pnpm check` 会依次执行 lint、类型检查、测试和生产构建，不启动示例服务。

`pnpm test:pack` 将同一 tarball 安装到无宿主 CLI 消费项目及混合宿主版本工作区，执行测试矩阵中的检查。日常 CI 从同一精确版本清单选取边界组合；支持范围由 `package.json` 的 peer dependencies 声明。发布流程运行 `pnpm check` 和默认全量的 `pnpm test:pack`。本地可用 `--profile daily` 或 `--profile platform` 缩小验证范围；手动触发 CI 并启用 `full` 可运行完整跨平台矩阵。真实 Electron 验收使用独立 job。日志包含分阶段耗时和最慢消费项目。

测试组织与覆盖边界见[测试指南](https://github.com/xova-dev/matrix/blob/main/test/README.md)。

## 文档站点

VitePress 位于私有 `docs` workspace，使用独立的宿主依赖。不修改 Matrix 包导出，也不将文档加入 npm 发布包；根级 `build`、`prepack` 仍只构建库。

安装 workspace 依赖后，在仓库根目录运行：

```bash
pnpm docs:typecheck
pnpm docs:build
pnpm docs:preview
```

实时编辑使用 `pnpm docs:dev`；用 `Ctrl+C` 停止服务后再执行其他命令。重新构建后重启已运行的 preview，刷新缓存的文件信息。站点为 GitHub 项目 Pages 使用 `/matrix/` base，本地预览也保持该前缀，请使用 VitePress 打印的访问地址。

站点内容放在 `docs/site/en/` 和 `docs/site/zh-CN/`，两种语言保持相同页面路径。单文件 `.vitepress/config.ts` 使用 `srcDir: 'site'`，将英文路由重写到站点根路径；不增加 `site/index.md` 或语言选择页。默认入口为 `/matrix/` 和 `/matrix/zh-CN/`。指南解释操作流程，参考页维护字段及契约。`getting-started.md` 继续引用根 README 的 `installation`、`quick-start` 区域，修改内容时保留标记。package 元数据与 workspace README 位于站点源目录之外。指向外部示例、测试说明的链接使用 GitHub。

VitePress 默认主题在语言切换时保留 URL 锚点。切换会选择对应页面，但本地化标题的章节 ID 不同，因此从某个章节切换语言时，不保证定位到同一节。本站保留默认行为，不增加自定义兼容层。

站点只维护一份正式文档，不提供版本选择器、历史快照或 Next 站点。默认主题导航从根目录 `package.json` 读取版本号，并链接到对应 GitHub Release。中英文更新日志页直接引用根目录 `CHANGELOG.md`；发布记录在该文件中维护，不复制到站点页面。

构建后的用户文档和示例导航链接到包版本对应的 tag，避免 README 和示例说明随未发布的 `main` 改动而漂移。源码 Markdown 可保留 `main` 链接供仓库内浏览，渲染器在构建时自动固定版本；本页的贡献者链接继续使用 `main`。检查与发布任务使用独立并发组，因此对同一 tag 手动运行检查不会取消正式部署。

文档工作流在相关 PR、`main` push 和手动运行时进行类型检查和构建，这些入口都不部署。正式 GitHub Release 的 npm 发布成功后，发布流程调用同一文档工作流，检出对应 release tag、检查它与 `package.json` 的版本一致，再构建站点。部署前确认它仍是最新正式 GitHub Release，旧版本重跑不会覆盖当前文档。npm 发布失败、预发布版和手动包发布都不更新 Pages。首次可部署的 Release 必须包含文档 workspace 和工作流，不回填尚未包含这些文件的历史 tag。

首次部署前，管理员需在仓库 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**，并允许 `github-pages` environment 从 `v*` 等发布 tag 部署，而不是仅允许 `main`。工作流不会自动启用 Pages 或修改环境保护规则。

包元数据与根 README 暂不假设在线文档地址。首次远端部署成功后再切换主入口；使用不同仓库名或自定义域名时，调整 VitePress `base`。
