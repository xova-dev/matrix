# CLI 参考

## 交互与直接执行

运行 `matrix` 进入“产品 → 动作 → 配置”。唯一候选自动选择；紧凑配置菜单直接显示当前变体和环境，可以运行、修改字段、查看执行详情或返回动作列表。详情包含依赖、Node 模式和等价命令。一次运行只选择一个产品，调整不会记忆到下次运行。

支持的交互终端中，向导使用临时屏幕，每次切换替换当前页面，不累计选择历史。运行、取消或异常退出都会恢复原终端；执行前打印选择摘要，执行结束后打印一次执行摘要，任务日志留在正常终端中。`ACCESSIBLE=1`、Clack 无障碍设置及 `TERM=dumb` / `TERM=unknown` 将提示保留在普通终端中，不切换屏幕、不清除页面。完整命令和非交互运行不会进入临时屏幕。

`matrix dev app` 等完整命令在终端里也直接执行：环境采用目标默认值，范围默认为全部变体。`matrix dev` 或 `matrix --product app` 等不完整命令只补选缺少的产品或动作，再显示配置菜单。非终端或 CI 环境中，如果产品或动作无法唯一确定，则报错并给出补全提示，不弹菜单。可以使用 `--product` 和 `--target` 显式选择，使用 `--help` 查看示例；也支持 `--env=name` 和重复的 `--variant` / `-v`。

CI 判断中，未设置、空值、`false` 和 `0` 在输入输出均为终端时允许交互；判断会去掉首尾空白并忽略大小写。其他非空值禁用提示和临时屏幕。

动作菜单包含单端专属目标并标注适用范围；选择后，配置菜单明确显示该范围。显式传入 `--variant` 时，只展示所选变体共同支持的动作。直接命令不会静默跳过不支持目标的变体，需要用 `--variant` 缩小范围。调整变体至少选择一项；返回动作列表时，本次向导调整重置为原始 CLI 参数和新目标的默认值。

## 命令

示例用 `matrix` 简写已安装的 CLI。使用本地 pnpm 依赖时，运行 `pnpm exec matrix ...`，或从 package script 中调用。

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

## 静态预检

`matrix doctor [--env <environment>]` 检查所选环境中的全部产品、变体和目标，不运行目标或准备命令、不探测端口、不生成类型，也不清理输出。配置加载仍会按原有方式执行配置文件。

- 错误包括不存在或不是目录的项目根路径、会删除项目根目录或祖先目录的清理配置，以及依赖错误、产物版本不可用等计划错误。版本优先级与清理安全规则和执行时保持一致。
- 对指向持续任务的 `completed` 依赖，以及缺少 `readyWhen` 的 `ready` 依赖报告警告；进程启动并不代表服务已就绪。
- 依赖计划错误保留原始任务及配置来源。同一根因只报告一次，受影响的下游任务列为 `Blocked`，不重复计为独立错误。
- 诊断标明项目或任务、配置路径和修正建议，不打印环境变量值。成功加载配置后尽量聚合独立检查；无法加载的无效配置仍立即失败。有错误时退出码非零，仅有警告时正常退出。
- 构建前尚未生成的输出目录、串行任务共用的输出目录均允许。Doctor 不推断应用环境要求，也不自动修复文件。

## 执行计划

`matrix plan app --target build` 输出 JSON，不执行任务。每个任务的 `env` 展示 Matrix 配置、所选产品和本次 dotenv 文件声明的变量，以及 `MATRIX_*`、`NODE_ENV` 的最终合并值，其中包含 Shell 覆盖结果。无关的继承 Shell 变量不展示，但仍会传递给子进程。不按变量名自动脱敏，因此 plan 输出可能包含敏感值，请勿直接粘贴到公开日志或 issue。完整的 plan 命令只输出 JSON，不显示交互摘要。

配置中的任意目标都可以通过 CLI 调用。自定义目标示例包括 `lint`、`e2e` 和 `release`。

## 选择范围与 CI

`--variant` / `-v` 支持逗号分隔和重复指定，例如 `matrix build app -v web,desktop`。依赖仍会自动展开。`doctor` 只接受 `--env`，检查所有产品；`prepare` 只接受可选产品和 `--env`，不接受变体或 target。实际运行一次选择一个产品；省略产品且无法唯一确定时，CI 必须显式提供它。
