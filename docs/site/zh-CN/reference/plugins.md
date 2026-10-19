# 插件与 runtime 参考

## 构建入口

以下入口导出相应宿主使用的默认 `matrix()` 插件工厂。接入步骤、Electron scope 和转换边界见[构建工具接入](../guides/integrations.md)。

| 入口                   | 宿主                 |
| ---------------------- | -------------------- |
| `@xova/matrix/vite`    | Vite / electron-vite |
| `@xova/matrix/rollup`  | Rollup               |
| `@xova/matrix/webpack` | Webpack              |
| `@xova/matrix/esbuild` | esbuild              |

默认虚拟模块为 `virtual:matrix/runtime`，设置 scope 后为 `virtual:matrix/runtime/<scope>`。这些模块由构建插件实现，不是 npm 中可直接解析的文件。

## 插件选项

将这些选项传给 Vite、Rollup、Webpack 或 esbuild 入口的 `matrix()`。它们属于宿主配置，不放在 `matrix.config.ts` 中。

| 选项        | 默认值                                    | 作用                                                                                                                                  |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `envPrefix` | 非 Vite 默认为 `VITE_`；Vite 使用最终前缀 | string 或 string 数组，控制公开字段。显式插件选项也会配置 Vite 前缀；始终加入 `MATRIX_`。前缀控制暴露范围，不决定变量是否传给子进程。 |
| `scope`     | 不设置                                    | 模块与类型隔离 key，仅使用字母、数字、下划线和连字符。每个编译上下文使用一个 scope。                                                  |
| `inline`    | `true`                                    | 将支持的静态读取替换为字面量；`false` 仅保留不可变虚拟 runtime 接入。                                                                 |
| `types`     | 有 Matrix 上下文时自动开启，Vitest 除外   | `false` 关闭生成；`true` 或对象形式显式开启，包括 Vitest 或缺少 Matrix 上下文时。`{ output: '...' }` 指定自定义路径。                 |

**默认行为变更：**缺少 Matrix CLI 上下文时，所有适配器的自动生成都保留现有声明、不创建输出目录，每个插件实例仅警告一次。请通过 Matrix 启动目标，或运行 `matrix prepare`。运行时配置可能不完整，显式开启类型生成不会补齐上下文。

Matrix CLI dev/build 的共享项目声明规则见[类型准备](../guides/integrations.md#类型准备)。

相对输出路径基于 Vite 最终 root 解析，其他适配器使用当前工作目录。默认文件为 `.matrix/types/matrix-runtime.d.ts`；设置 scope 后为同目录下的 `matrix-runtime-<scope>.d.ts`。自定义输出需加入项目的 `tsconfig.json`。

## Runtime 字段

| 字段                                      | 含义                                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `environment`                             | 选择的 Matrix 配置环境，如 `staging`、`qa`。                                                             |
| `target`                                  | 当前 Matrix 目标，如 `build`。                                                                           |
| `nodeEnv`                                 | 解析后的 Node 进程模式，与配置环境区分。                                                                 |
| `isDevelopment`、`isProduction`、`isTest` | 从 `nodeEnv` 派生的模式标记。                                                                            |
| `variant`、`project`                      | 当前构建上下文的变体和项目 key。                                                                         |
| `product`                                 | 产品的 `key`、`id`、`name`、`slug`，以及可选的 `appId`、`version`。                                      |
| `config`                                  | 去掉公开前缀并转为 camelCase 的环境字段；`VITE_API_BASE` 对应 `apiBase`。schema 字段保持声明的标量类型。 |

只公开允许进入应用构建产物的值。声明 schema 不会让 secret 变得适合公开；Matrix 也不替代应用框架自身的环境系统。
