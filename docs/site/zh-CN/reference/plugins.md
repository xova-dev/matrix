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

| 选项        | 默认值                                    | 作用                                                                                                                                            |
| ----------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `envPrefix` | 非 Vite 默认为 `VITE_`；Vite 使用最终前缀 | string 或 string 数组，控制公开字段。显式插件选项也会配置 Vite 前缀；始终加入 `MATRIX_`。前缀控制暴露范围，不决定变量是否传给子进程。           |
| `scope`     | 不设置                                    | 模块与类型隔离 key，仅使用字母、数字、下划线和连字符。每个编译上下文使用一个 scope。                                                            |
| `inline`    | `true`                                    | 将支持的静态读取替换为字面量；`false` 仅保留不可变虚拟 runtime 接入。                                                                           |
| `types`     | 默认开启，Vitest 的自动生成除外           | `false` 关闭声明生成；`true` 显式开启；`{ output: '...' }` 指定相对于生成根目录的输出路径。Vite 使用最终项目 root，其他适配器使用当前工作目录。 |

自定义类型输出时，将该文件加入消费项目的 `tsconfig.json`。默认声明为 `.matrix/types/matrix-runtime.d.ts`；设置 scope 后为 `.matrix/types/matrix-runtime-<scope>.d.ts`。

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
