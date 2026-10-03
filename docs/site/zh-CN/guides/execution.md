# 执行与产物

## 目标和默认值

内置目标的默认值如下：

| 目标      | 配置环境      | Node 模式     | 是否持续运行 |
| --------- | ------------- | ------------- | ------------ |
| `dev`     | `development` | `development` | 是           |
| `build`   | `production`  | `production`  | 否           |
| `dist`    | `production`  | `production`  | 否           |
| `preview` | `production`  | `production`  | 是           |
| `test`    | `development` | `test`        | 否           |

自定义目标默认不会持续运行，未指定 `--env` 时使用 `development`。内置目标的运行模式为：`dev` 使用 `development`，`test` 使用 `test`，`build`、`dist` 和 `preview` 使用 `production`。自定义目标也可以将 `nodeEnv` 配置为 `development`、`production` 或 `test`。项目默认使用当前目录，目标输出目录默认为 `dist`，产物根目录默认为 `artifacts`。Target 可以使用字符串数组顺序执行多个命令，例如 `release: ['pnpm build', 'pnpm package']`。产物默认使用 `move` 模式，归档格式默认为 ZIP；需要归档时只需将 `artifacts.mode` 设置为 `archive` 或 `both`。启用产物交付时，`artifacts.clean` 默认为 `true`，会在每个非持续 Target 执行前清理输出目录，确保产物只包含本次执行的输出。`archive` 模式会保留本次输出目录，`move` 和 `both` 会将其移动到产物目录。产物命名为 `<variant>-<version>-<YYYYMMDD-HHmmss>`，默认按 Product、Environment、Variant 保留最近 5 个 ArtifactSet。

## 执行摘要与失败诊断

实际执行在子进程清理完成后统一输出一次最终摘要，覆盖成功、失败和取消：包含整体结果、耗时、各任务与项目准备步骤的状态，以及已生成的产物路径。`matrix prepare` 会等类型生成结束后再输出同一份摘要，并包含生成的声明文件路径。

- 有限任务仅在命令和已配置的产物交付均成功后标记为 `completed`。失败项为 `failed`，尚未启动的任务与准备步骤保持 `not run`。
- 用户取消时，正在执行的有限任务为 `cancelled`。持续服务正常退出或被 Matrix 关闭时为 `stopped`，不算完成；因后台服务失败而中断的其他任务也为 `stopped`，不误报为失败。
- 失败诊断标识具体的 `product:variant:target`、阶段（`preparation`、`command`、`readiness` 或 `artifact handling`）及底层错误或退出码；顺序命令标识失败步骤编号。项目准备失败会标识项目，并在可确定时指出受影响任务；清理失败单独报告。

执行仍保持串行，子进程输出与终端交互原样透传。Matrix 的执行进度只标识任务与命令步骤，不回显配置的完整命令、不转储环境变量。诊断保留错误消息和路径，不猜测敏感键名、不替换值；仅清理自身诊断行中的终端控制字符。错误消息、路径和子进程输出仍可能含敏感信息，公开日志前需自行检查。不会捕获或改写子进程输出。现有 CLI 退出码保持不变：执行失败为 `1`，SIGINT 为 `130`，SIGTERM 为 `143`。`matrix plan` JSON 的独立披露边界见[执行计划](../reference/cli.md#执行计划)。

## 项目准备

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
- `matrix plan` 只展示准备步骤：JSON 的 `preparations` 包含命令、工作目录、环境和 `beforeTask`；`doctor` 执行静态预检，两者均不执行准备命令。

`project.prepare` 与名为 `prepare` 的普通 target 是不同概念。准备阶段本身不会递归触发准备，也不支持依赖、持续服务或产物交付选项。

## 进程关闭

进程树关闭在 macOS/Linux 使用系统 `ps` 命令（精简 Linux 镜像需安装 `procps`），在 Windows 使用 `taskkill.exe`。POSIX 任务先收到 SIGTERM，必要时在 30 秒后收到 SIGKILL；Matrix 等待受控进程组停止，而不只是 shell 退出。

## 产物交付

产物交付在每个 target 上显式启用。不配置 `artifacts` 时，输出保留原位，Matrix 不进行执行前清理；根级 `artifacts` 只控制目的目录和保留数量。持续目标不执行产物清理或交付。

有限目标的顺序为：**清理输出 → 按需准备项目 → 执行命令 → 交付产物 → 清理旧集合**。需要复用之前输出时可设置 `clean: false`；此时 Matrix 不保证产物只包含本次构建的输出。

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  artifacts: { root: './artifacts', retention: { keep: 3 } },
  projects: {
    web: {
      root: './apps/web',
      targets: {
        build: {
          command: 'pnpm build',
          outputDir: 'dist',
          artifacts: { mode: 'archive', format: 'tar.gz', clean: true },
        },
      },
    },
  },
  products: { app: { version: '1.0.0', variants: { web: 'web' } } },
})
```

| 模式      | `<artifacts.root>/<product>/<environment>/` 下的结果 | 源输出目录 |
| --------- | ---------------------------------------------------- | ---------- |
| `move`    | `<variant>-<version>-<timestamp>/`                   | 被移动。   |
| `archive` | `<variant>-<version>-<timestamp>.zip` 或 `.tar.gz`   | 保留原位。 |
| `both`    | 包含输出及其同名归档的移动目录                       | 被移动。   |

timestamp 使用执行机器本地时间，格式为 `YYYYMMDD-HHmmss`。保留策略按产品／环境／变体跨版本统计产物集合，不统计单个文件；`both` 算一个集合。成功交付后清理较旧的匹配集合，target 名称不参与分组。目的路径已存在时报错，不覆盖。

产物目标必须解析出有效发布版本，且命令完成后输出目录必须存在。清理拒绝项目根目录及其祖先，但仍会删除配置的输出目录；不要把源码或共享准备缓存放在那里。首次使用前运行 `matrix doctor` 并检查路径。使用 `move` 或 `both` 后，后续 `preview` 需要保留或重新生成输出目录。

执行按计划串行推进，持续服务可以在后续任务启动时保持运行。Matrix 不是并行构建调度器，也不提供跨调用的共享目录锁。
