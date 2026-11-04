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

- `prepare` 是独立生命周期，不是 target 的第一条命令。Matrix 解析上下文，顺序执行准备数组，发现／加载宿主，收集类型，再启动 target 命令。自定义目标也执行声明的准备，但不自动收集宿主类型。
- 每次准备携带完整产品、变体、所选环境、解析后的身份／版本以及目标 Node 模式。`MATRIX_TARGET` 表示正在准备的上下文（共享收集时为 `dev` 或 `build`），不是 CLI 动作 `prepare`。命令在项目根目录执行；数组每项都是独立 shell 进程，文件产物保留，`cd`、`export` 不传递到下一项。
- 规划阶段在用户命令运行前捕获这些上下文，包括共享收集涉及的其他产品及未声明准备命令的项目。准备、宿主收集与 target 共用同一快照：准备期间改写 `package.json` 不会改变本次调用已解析的版本；下一次调用重新读取输入。未使用上下文中的错误仅在收集实际访问它时报告。
- 共享类型收集遍历相关产品／变体的 dev/build 宿主上下文。每次访问先建立自己的输入，再发现宿主，因此支持准备命令生成宿主配置文件。收集后再次准备当前任务，避免读取另一个产品留下的文件。不按项目或跨调用缓存准备完成状态；脚本必须可重复执行，建议仅在内容变化时写文件。
- `matrix prepare [product]` 完成准备和声明生成后结束，不执行业务目标。product 选择项目，其共享类型归属可能涉及其他产品。原生 `typegen: false` 项目仍准备所选产品的 dev/build 上下文，但不加载宿主、不加入共享类型归属。显式 prepare 与自动 build/dev 均从所选类型所有者决定类型收集范围：没有类型所有者时，仍执行所选准备流程，但不解析无关类型项目目录、不发布声明。见[类型准备](./integrations.md#类型准备)。
- `target.prepare: false` 在自动执行／收集时跳过该目标上下文的用户准备，不关闭类型收集或其他上下文的准备；显式 `matrix prepare` 始终执行准备。只有不需要生成输入的上下文才适合跳过。任意命令失败或取消后，不再执行后续命令或加载宿主。
- 启用产物清理时，顺序为“清理当前目标输出 → 完成准备／类型收集 → 重新建立当前输入 → 执行 target → 交付产物”。共享准备输入应放在其他任务不会清理或移动的目标输出目录之外。
- Matrix 从准备开始到 target 结束及子进程清理完成，一直持有工作区锁。同一工作区的另一调用等待锁，等待可以取消。执行会话统一持有命令、宿主 worker 和文件操作，在启动进程或修改文件之前按实际路径取得资源占用，包括符号链接别名和项目根目录之外的输出。target 读取项目／工作目录，并写入声明的 `outputDir`，即使未配置产物交付或设置了 `clean: false` 也一样。准备与宿主收集独占项目根目录；声明发布、清理和交付持有各自写入目录。允许只读共享，拒绝重叠的读写或写写占用，应隔离目录或停止冲突服务。进程占用持续到整个受控进程树停止，包括宿主配置启动的普通辅助进程，之后才能准备下一上下文的输入。任意脚本若写入声明目录之外，需使用独立工作区或自行协调资源。不要在准备／target 命令中递归调用同一工作区的 Matrix。
- 自动 build/dev 准备先建立当前上下文并检查宿主。没有宿主的原生项目，即使未设置 `typegen: false`，也不会遍历无关类型归属项目的根目录；只有确认需要宿主类型收集后才展开共享目录。
- CLI 在执行过程中意外死亡时，Matrix 无法证明目标子进程已停止，因此保留锁并拒绝自动回收，避免另一个产品覆盖其输入。清理失败也会保留占用。只有停止该次执行的全部进程后，才能按错误中给出的路径手动移除锁。执行开始前死亡的锁所有者仍可自动回收。
- `matrix plan` 展示所选任务的准备命令、工作目录、完整上下文和 `beforeTask`；运行时共享类型收集可能访问更多相关上下文。`doctor` 仍是静态预检，两者都不执行准备；因此 doctor 在准备之前可能报告尚未生成的显式宿主配置不存在。

**迁移说明：** 旧 `project.prepare` 按项目只执行一次，仅有项目级环境；现在按上下文执行，一次调用可能执行多次，并携带产品环境和解析后的身份／版本。把生成输入的命令从 target 数组移入 `project.prepare`，删除重复步骤，并确保初始化命令可重复执行。字符串和非空字符串数组的语法不变，无需新增 `prepareHost`、hook 对象或手动预跑命令。

`project.prepare` 与名为 `prepare` 的普通 target 是不同概念。准备阶段本身不会递归触发准备，也不支持依赖、持续服务或产物交付选项。

## 进程关闭

命令和宿主 worker 使用同一进程所有权契约：根进程结果与回收完成分开表达。执行会话统一管理目录占用，并等待回收完成后才释放。宿主 worker 在两平台使用同一消息协议；取消时先请求框架清理，再由后端清空进程容器。回收失败时保留占用和工作区锁。

关闭时会尝试全部独立清理，并等待它们结束。有依赖的清理保持顺序：先关闭框架，再释放进程容器，确认释放成功后才解除目录占用。执行与清理同时失败时，Matrix 保留两者的原因；一个失败不会覆盖其他失败，也不会阻止剩余清理尝试。

进程所有权覆盖整个容器，不只覆盖最初的 shell 或 worker。macOS/Linux 使用进程组和系统 `ps` 命令（精简 Linux 镜像需安装 `procps`）；POSIX 任务先收到 SIGTERM，必要时在 30 秒后收到 SIGKILL。

Windows 通过系统自带 Windows PowerShell/.NET 使用内核 Job Object；系统策略需允许本地辅助程序调用 `Add-Type`。Matrix 通过同一次原生创建调用（`PROC_THREAD_ATTRIBUTE_JOB_LIST`）建立 Job 归属并挂起创建命令或宿主 worker，随后恢复执行。因此，监管进程在创建与恢复之间崩溃也不会遗留无所有者的挂起进程。父进程退出后，后代仍归属于该 Job，包括 detached 子进程。只有 Job 确认活跃进程数为零，session 才释放目录占用。协调器断连会清空 Job，所有者句柄关闭也会终止成员。启动失败保留原始原因，清理仍会停止监管进程并尝试释放全部通信资源；清理失败仍按失败处理。不回退到按 PID 清理或无所有权执行。辅助程序仅作用于当前进程，不安装软件、不修改系统执行策略。

## 产物交付

产物交付在每个 target 上显式启用。不配置 `artifacts` 时，输出保留原位，Matrix 不进行执行前清理；根级 `artifacts` 只控制目的目录和保留数量。持续目标不执行产物清理或交付。

有限目标的顺序为：**清理输出 → 完成上下文准备 → 执行命令 → 交付产物 → 清理旧集合**。需要复用之前输出时可设置 `clean: false`；此时 Matrix 不保证产物只包含本次构建的输出。

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

执行按计划串行推进，持续服务可以在后续任务启动时保持运行。同一工作区的多次调用由 Matrix 串行协调。Matrix 不是并行构建调度器，也不协调不同工作区之间的共享目录。
