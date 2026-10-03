# 排错指南

## 先核对选择的上下文

在包含 `matrix.config.ts` 的目录查看 `matrix --help`，运行 `matrix doctor --env staging`，再用 `matrix plan app --target build --env staging` 检查实际产品和目标。Doctor 检查全部产品；plan 只展开所选入口及其依赖。两者不运行 target 或项目准备命令，但仍会执行配置代码。

plan JSON 可能含敏感环境值，不要未经检查就公开。执行日志原样透传子进程输出，也不自动脱敏。

## 命令缺失或执行了错误目标

内置目标名只提供默认值，不自动提供框架命令。请在 `projects.<key>.targets` 声明目标。CLI 使用产品 key，`--variant` 和 `dependsOn` 使用产品内的变体 key。只有一个变体支持动作时，用 `matrix preview app --variant web` 缩小范围；Matrix 不静默忽略不支持目标的变体。

自定义目标名为 `help`、`plan`、`doctor`、`prepare` 时，用显式形式，例如 `matrix -p app -t prepare`。变体覆盖后意外丢失依赖或产物设置时，改用对象覆盖而非命令字符串。见[配置参考](../reference/configuration.md#target-覆盖)。

## CI 没有提示，或交互行为与预期不同

`matrix dev app` 等完整命令即使在终端也直接执行。向导只在 stdin/stdout 均为终端且 CI 判断允许时补选缺失的产品／动作。CI 中显式指定产品、目标、环境及变体。`ACCESSIBLE=1` 和不支持的终端类型将提示保留在普通屏幕。见[CLI 行为](../reference/cli.md#交互与直接执行)。

## 服务就绪超时，或下游启动过早

把 `readyWhen` 配置在依赖服务上，确保实际主机／端口与探测一致。默认 host 为 `127.0.0.1`，超时为 30 秒。没有探测的 `ready` 依赖不等待应用就绪；TCP 可连接也不等于 HTTP 健康。增加超时前，先检查子进程日志和端口冲突。

持续服务使用 `ready`，有限构建使用 `completed`。简写依赖按被依赖目标的 `continuous` 标记选择条件，而不是按消费目标选择。见[就绪与依赖](../reference/configuration.md#就绪探测)。

## staging 构建显示 production，或环境值不生效

staging 构建得到 `MATRIX_ENV_NAME=staging` 和 `NODE_ENV=production` 是正常行为：配置环境与进程模式不同。Shell 覆盖优先于 dotenv、产品和全局值；修改 schema 默认值前，先确认选择的产品与环境。

只有宿主公开前缀内的字段进入 `matrix.config`；声明 `envSchema` 不扩大公开前缀。`VITE_API_BASE` 对应 `matrix.config.apiBase`。boolean 字符串必须精确为 `true` 或 `false`；最终值非法时直接报错，不回退默认值。见[环境说明](environments.md)。

## 找不到虚拟 runtime 模块或类型

在实际宿主构建中安装并配置 Matrix 插件；仅生成声明不能实现 `virtual:matrix/runtime`。运行 `matrix prepare app`，将 `.matrix/types` 加入消费项目的 `tsconfig.json`，并使 import 后缀与插件 scope 一致。例如 `main` scope 使用 `virtual:matrix/runtime/main`。

Electron main/preload 使用不同 scope；自定义类型输出时也要加入对应路径。Vitest 默认关闭插件自动类型生成，可用 `types: true` 显式开启；`types: false` 也关闭 prepare 输出。没有通过 Matrix 启动的独立构建不接收 Matrix 内部 schema 上下文。

宿主发现失败时，显式设置项目 `configFile`；文件名仍须符合 `vite.config.*` 或 `electron.vite.config.*` 的 JS/TS 模块扩展名规则。其他宿主保留通用类型准备，不解析其宿主配置。旧声明不会自动删除；修改 scope／输出路径后，检查过期文件。见[类型准备](integrations.md#类型准备)。

## 构建后的值不变化，或无法修改快照

虚拟 runtime 是不可变的构建期快照，不是部署后动态配置。修改环境后重启开发／构建上下文；交付新值需要重新构建。需要可变状态时复制到应用自己的对象，不要写入 `matrix`、`matrix.product` 或 `matrix.config`。

tree shaking 需要支持的静态读取及宿主优化。动态 key、解构、别名或有副作用的静态 import 不具备同样的删除保证。esbuild／自定义 loader 冲突时，将必需的源码 loader 放在前面，或使用 `matrix({ inline: false })`；这关闭 Matrix 内联，不关闭虚拟模块。见[接入边界](integrations.md#不可变快照与-tree-shaking)。

## 没有产物，或 preview 找不到 dist

根级 `artifacts` 不启用交付，请配置 target 的 `artifacts`。有限命令必须成功、输出目录必须存在，且环境、变体、产品或当前项目的 `package.json` 必须能提供有效版本；不向父目录查版本。

`move`、`both` 会移走源输出；其他目标需要原位消费时使用 `archive`。`clean` 默认开启，后续目标可能清理之前输出。共享准备文件放在输出目录之外。相同产品／环境／变体的保留策略跨 target 名称共享。见[产物交付](execution.md#产物交付)。

## 项目准备没有产品值，或重复运行

这是预期行为：准备以项目为单位，每次调用按 project key 去重，没有跨调用完成缓存。使用全局／dotenv／Shell 值，不使用产品身份或产品 env。产品专属生成放在 target 命令中，共享准备应可重复执行。`target.prepare: false` 只跳过该目标，不阻止后续准备。见[项目准备](execution.md#项目准备)。

## 精简镜像中的进程关闭失败

检查系统进程管理命令：macOS/Linux 需要 `ps`（精简 Linux 镜像安装 `procps`），Windows 需要 `taskkill.exe`。POSIX 先发送 SIGTERM，30 秒后必要时发送 SIGKILL；Matrix 等待受控进程组停止。见[进程关闭](execution.md#进程关闭)。
