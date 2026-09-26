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

运行 `matrix` 进入“产品 → 动作 → 配置”。唯一候选自动选择；紧凑配置菜单直接显示当前变体和环境，可以运行、修改字段、查看执行详情或返回动作列表。详情包含依赖、Node 模式和等价命令。一次运行只选择一个产品，调整不会记忆到下次运行。

支持的交互终端中，向导使用临时屏幕，每次切换替换当前页面，不累计选择历史。运行、取消或异常退出都会恢复原终端；执行前只打印一次最终摘要，任务日志留在正常终端中。`ACCESSIBLE=1`、Clack 无障碍设置及 `TERM=dumb` / `TERM=unknown` 将提示保留在普通终端中，不切换屏幕、不清除页面。完整命令和非交互运行不会进入临时屏幕。

`matrix dev app` 等完整命令在终端里也直接执行：环境采用目标默认值，范围默认为全部变体。`matrix dev` 或 `matrix --product app` 等不完整命令只补选缺少的产品或动作，再显示配置菜单。非终端或 CI 环境中，如果产品或动作无法唯一确定，则报错并给出补全提示，不弹菜单。可以使用 `--product` 和 `--target` 显式选择，使用 `--help` 查看示例；也支持 `--env=name` 和重复的 `--variant` / `-v`。

完整的可运行示例见 [`examples/basic`](examples/basic/README.md)，它不依赖具体前端框架。

CI 判断中，未设置、空值、`false` 和 `0` 在输入输出均为终端时允许交互；判断会去掉首尾空白并忽略大小写。其他非空值禁用提示和临时屏幕。

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

配置文件求值期间可以通过 `process.env` 读取本次 dotenv，继承的 Shell 变量保持更高优先级。每次配置加载或环境列表读取都在短生命周期 Worker 中执行，拥有独立环境和完整的 ESM/CommonJS 模块缓存；本地配置依赖随本次加载一起求值，不修改宿主环境或宿主模块缓存。结果返回后 Worker 会被销毁，因此配置文件应生成数据，不应启动持久服务。执行计划保留独立环境快照；返回的 `layers` 是 JSON 诊断快照，不携带可执行对象。

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

运行一次 `matrix prepare` 会在所选 product 引用的每个 project 目录下生成 `.matrix/types/matrix-runtime.d.ts`。如果多个 product 复用同一个 project，该 project 的声明会合并这些 product 的公开环境变量键。它会根据 `VITE_*`（以及配置的其他公开前缀）生成 `ImportMetaEnv` 和 `matrix.config` 的键类型，不会写入环境变量的实际值。构建插件默认也会在解析最终 `envPrefix` 后生成对应类型；但在 Vitest 环境中默认不会覆盖已有类型，可通过 `types: true` 或 `types: { output: '...' }` 显式开启，也可通过 `types: false` 始终关闭。将每个 project 下的 `.matrix/types` 加入对应 `tsconfig.json` 的 `include` 即可获得类型提示：

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

动作菜单包含单端专属目标并标注适用范围；选择后，配置菜单明确显示该范围。显式传入 `--variant` 时，只展示所选变体共同支持的动作。直接命令不会静默跳过不支持目标的变体，需要用 `--variant` 缩小范围。调整变体至少选择一项；返回动作列表时，本次向导调整重置为原始 CLI 参数和新目标的默认值。

`matrix plan app --target build` 输出 JSON，不执行任务。每个任务的 `env` 展示 Matrix 配置、所选产品和本次 dotenv 文件声明的变量，以及 `MATRIX_*`、`NODE_ENV` 的最终合并值，其中包含 Shell 覆盖结果。无关的继承 Shell 变量不展示，但仍会传递给子进程。不按变量名自动脱敏，因此 plan 输出可能包含敏感值，请勿直接粘贴到公开日志或 issue。完整的 plan 命令只输出 JSON，不显示交互摘要。

配置中的任意目标都可以通过 CLI 调用。常见的自定义目标包括 `test`、`lint` 和 `e2e`。

### 项目准备

在 Project 上声明可选的 `prepare`，支持与 target command 相同的字符串或字符串数组。数组按顺序执行；空命令和完整 target 对象不受支持。

```ts
export default {
  projects: {
    desktop: {
      root: './apps/desktop',
      prepare: ['pnpm run setup', 'pnpm run generate'],
      targets: {
        dev: 'pnpm dev',
        build: 'pnpm build',
        lint: { command: 'pnpm lint', prepare: false },
      },
    },
  },
  products: { app: { variants: { desktop: 'desktop' } } },
}
```

- 自动运行时，在该项目第一个需要准备的 target 启动前执行；包括依赖展开后涉及的项目，不执行无关项目的准备。
- 每次调用按 Project key 去重，多个产品或变体复用同一项目时只准备一次。全部命令成功后才算完成，不跨调用缓存；准备脚本应可重复执行，资源缓存由工具自身负责。
- 启用产物清理时，顺序为“清理目标输出目录 → 按需 prepare → 执行 target → 交付产物”。后续变体仍可能清理或移动输出目录，因此跨变体复用的准备文件应放在 target 输出目录之外；每次构建都需要生成的输出文件应放入 target 命令数组，而不是一次性的项目准备。
- `target.prepare: false` 只跳过当前目标，不影响后续其他目标的准备需求。准备失败或取消会停止本次执行，不启动后续目标。
- 准备命令在 project 根目录执行，使用全局配置、当前 dotenv 和 Shell 环境，不合并产品级 env 或注入产品／变体身份。不继承某个目标的默认 NODE_ENV，保留全局／外部环境中的值；注入 `MATRIX_PROJECT`、`MATRIX_ENV_NAME` 和 `MATRIX_TARGET=prepare`。
- `matrix prepare [product]` 显式准备所选产品引用的项目（省略产品则处理所有产品），成功后生成现有 runtime 类型，不运行业务 target。构建插件的自动类型生成功能保持不变。
- `matrix plan` 只展示准备步骤：JSON 的 `preparations` 包含命令、工作目录、环境和 `beforeTask`；`doctor` 只校验配置和依赖，两者均不执行准备命令。

`project.prepare` 与名为 `prepare` 的普通 target 是不同概念。准备阶段本身不会递归触发准备，也不支持依赖、持续服务或产物交付选项。

## 命令

短参数：`-p` / `--product`、`-t` / `--target`、`-e` / `--env`、`-v` / `--variant`、`-h` / `--help`。原有 `--mode` 别名已移除，请改用 `--env` 或 `-e`。同一参数混用长短形式仍按重复参数报错，变体参数除外，允许重复指定。交互生成的等价命令使用短参数。

参数语法统一由 Node 的严格参数解析器处理，Matrix 只校验重复选择、变体列表和命令专属组合；帮助从同一份参数定义生成。支持 `--env=staging`，也保留已有的 `-e=staging` 写法。

```bash
matrix dev app -v desktop -e staging
matrix plan app -t build -e production
matrix -p app # 继续交互选择动作
```

自定义目标与 `help`、`plan`、`doctor` 或 `prepare` 同名时，使用显式目标参数，例如 `matrix -p app -t prepare -e development`。生成的等价命令也会使用这一形式，避免误入内置命令分支。

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

`pnpm lint:fix` 通过 ESLint 格式化 JavaScript、TypeScript 和 Markdown。`pnpm check` 会依次执行 lint、类型检查、测试和生产构建，不启动示例服务。

`pnpm test:pack` 将打包产物安装到临时消费项目，验证导出、配置隔离、准备流程及 CLI 关闭。关闭验收使用两个不占用网络端口的最小进程；在 macOS/Linux 向 Matrix 发送 SIGINT，检查退出码 130、清理完成且没有测试进程残留。Windows 会明确跳过这条 POSIX 信号验收，其他打包检查仍执行。成功时输出简短摘要，失败时提供诊断日志。发布流程同时运行 `pnpm check` 和 `pnpm test:pack`。

## 许可证

[MIT](LICENSE)
