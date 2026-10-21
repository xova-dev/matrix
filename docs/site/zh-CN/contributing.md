# 开发与验证

示例分为轻量的 `examples/basic` 和真实的 [双 Web / 共享 Electron 示例](https://github.com/xova-dev/matrix/blob/main/examples/electron-web/README.md)，统一加入 pnpm workspace；安装方式和验证边界见 [示例导航](https://github.com/xova-dev/matrix/blob/main/examples/README.md)。根目录执行 `pnpm install --frozen-lockfile`、`pnpm build` 后，可用 `pnpm example:basic` 打开入门向导，或用 `pnpm example:electron-web` 准备 Electron 项目。`pnpm check:examples` 检查两个 Matrix 配置；`pnpm test:electron-web` 则在仓库外、依赖锁定的临时项目中独立安装本次 tarball，验收开发、构建和真实应用启动。

CI 在同一来源 SHA 上并行运行只读的 code、docs 任务；Publish 通过 Xova Actions 工作流验证带标签的完整最终候选。测试矩阵、发布检查和本地集成 fixture 统一见[测试指南](https://github.com/xova-dev/matrix/blob/main/test/README.md#ci-environments)。

开发依赖版本维护在 `pnpm-workspace.yaml` 的 pnpm catalog 中；发布包消费端测试版本与类型检查基线维护在 `scripts/compatibility-matrix.json` 中。

```bash
pnpm install
pnpm check
pnpm lint:fix
```

`pnpm lint:fix` 通过 ESLint 格式化 JavaScript、TypeScript 和 Markdown。`pnpm check` 会依次执行 lint、类型检查、测试和生产构建，不启动示例服务。

`pnpm test:pack` 在隔离消费项目中验证安装后的 tarball，默认运行全量组合；本地可用 `--profile daily` 或 `--profile platform` 缩小范围。手动触发 CI 并启用 `full` 可运行完整跨平台验证。支持范围由 `package.json` 声明，覆盖边界与组合定义见[测试指南](https://github.com/xova-dev/matrix/blob/main/test/README.md)。

## 发布准备与交付

原生 release-it 从 .release-it.json 固定的修订继承准备预设。使用明确的目标版本；下面的 0.4.0 仅为示例。预设关闭 Git 交付、npm 发布以及 GitHub/GitLab Release：

```bash
mise exec -- pnpm exec release-it 0.4.0 --ci --dry-run
mise exec -- pnpm exec release-it 0.4.0 --ci
```

准备要求工作区干净，更新包版本和根 `CHANGELOG.md`。预览成功不代表执行了项目检查。审查差异和暂存区：官方插件可能暂存新建的 changelog。失败时保留部分结果。检查记录并补充必要的迁移文档、示例或代码；候选提交不限制为版本和 changelog 文件，标题也不豁免检查。提交、标签、推送和创建 GitHub Release 继续分别遵循授权；创建 GitHub Release 会触发发布。
CI 和发布共用产品自己的 `checks.yml`，命令和文档参数统一声明在 `.github/xova.json`。质量任务调用共享 `check.yml`；兼容性和 Electron 任务保留产品所有权，在质量检查成功后启动。普通 CI 可以使用共享纯文档判断；Publish 对精确来源 SHA 保持完整检查，之后调用共享 `release.yml`。通用 setup、配置校验、来源/恢复门禁与上游行为回归归 Xova Actions 维护。共享工作流默认读取 .github/xova.json，命令/setup 不提供工作流输入覆盖；文档检查、发布构建和恢复统一使用 check(kind=docs)，自定义任务仍可直接组合操作 actions。

共享 setup 在 setup.cache 中仅声明 pnpm 缓存，以 pnpm-lock.yaml 区分；文档直接继承该选择。npm 下载缓存保留在执行 npm 消费验证的兼容性任务中，避免只跑 pnpm 的质量检查先写入空的 npm 缓存。checks.yml 继续维护产品专属的 Electron 二进制缓存。兼容性和 Electron 验收步骤将 TMPDIR/TEMP/TMP 设为 runner.temp，让 Windows 临时消费项目使用检出所在卷和已缓存的 pnpm store。命中后仍执行安装、产品检查和来源校验。

发布选择 pnpm 打包。在同一 SHA 的完整产品检查成功后，发布器只执行 `pnpm build`，不重复 lint、类型和示例检查；随后使用提供的绝对路径 `TARBALL` 执行 `pnpm test:pack --profile daily`，直接消费该文件、不重新打包，发布前再次检查源码和 tarball 字节。未提供 `TARBALL` 时本地 `test:pack` 仍先打包一次。发布工具使用 Node 24，产品的 Node 22.18.0 兼容性检查保持独立。

`docs-recover.yml` 只保留手动入口，将已确认的发布标签/SHA 传给共享恢复流程。发布和恢复使用相同的 `github-pages` 环境、并发组以及 `latest-stable` 策略。Publish 只在稳定 release 事件部署，手动发布不部署；恢复从已确认源码重建，不重复发布 npm。

npm Trusted Publisher 继续标识 `xova-dev/matrix`、入口 `publish.yml` 与环境 `npm-publish`。环境和 Pages 策略仍由管理员配置。消费方测试只覆盖产品矩阵和接线，共享仓库负责通用发布与恢复回归。

四处共享工作流引用统一固定到远端 CI 已通过的同一个工具库完整 SHA。普通 `mise exec -- pnpm check` 不依赖本地工具库绑定；可选使用 `XOVA_ACTIONS_ROOT=../actions mise exec -- pnpm check`，绑定同一工具库修订，额外校验真实工作流契约和配置解析器。绑定验证会在读取契约前拒绝不同 HEAD 或受跟踪文件、暂存区改动。准备预设继续独立固定。工具库 CI 不代表嵌套必需检查名称、Matrix 托管运行、OIDC 或真实部署已经验收。

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

CI 的 docs 任务在每个 PR、main push 和手动 CI 运行中检查类型、构建并保存产物，不部署；它不依赖 code 任务，纯文档优化只影响代码路径。Publish 在 npm 发布前构建 release tag 对应的站点，发布成功后复用该产物部署。只有最新正式 GitHub Release 更新 Pages；发布失败、预发布版和手动发布都不更新站点。

如果 npm 已成功而文档部署失败，先用原生 npm 日志、registry 状态与 provenance 确认已发布版本及准确 SHA；报告或上传失败可能让 npm 任务自身在发布后失败。共享发布 JSON/摘要可辅助核对，但不是独立 registry 证明。再运行 **Recover documentation**（`docs-recover.yml`），填写确认后的 `release-tag`、`published-sha`，不重复发布 npm。两条路径读取相同 `.github/xova.json`，共用锁，并在进入 `github-pages` 后检查最新正式 Release；来源错误失败，过期版本跳过。产物仓库、SHA 和内容摘要覆盖隐藏站点文件。

恢复运行的 ref 也必须选择同一个发布 tag；当前 `github-pages` 仅允许 `v*` 标签。原生 ref/SHA 不匹配时会在构建前失败。所选 tag 必须包含 `docs-recover.yml` 和 `.github/xova.json`。共享配置路径不能为空，文件缺失时在安装或执行产品命令前失败。

首次部署前，管理员需在仓库 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**，并允许 `github-pages` environment 从 `v*` 等发布 tag 部署，而不是仅允许 `main`。工作流不会自动启用 Pages 或修改环境保护规则。

包元数据与根 README 暂不假设在线文档地址。首次远端部署成功后再切换主入口；使用不同仓库名或自定义域名时，调整 VitePress `base`。
