# 配置参考

本页用于查阅 `matrix.config.ts` 的字段、默认值和覆盖契约。概念及多变体示例见[核心概念](../concepts.md)。

## 根配置

在工作区根目录使用 `matrix.config.ts`，导出 `defineMatrixConfig({...})`，并从该目录运行 CLI。以下表格描述用户配置，不是标准化执行计划的输入。

| 字段                       | 类型／默认值             | 作用                                                                                       |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `projects`                 | Project 映射；必填       | 可复用项目目录和命令。                                                                     |
| `products`                 | Product 映射；必填       | 由绑定项目的变体组成的交付物。                                                             |
| `env`                      | Scalar 映射；可选        | 全局 string、number、boolean 环境值。                                                      |
| `$env`                     | 环境映射；可选           | 全局环境覆盖，每个条目包含 `env`。                                                         |
| `envSchema`                | 字段映射；可选           | 共享类型、默认值和可选性，见[环境变量 schema](../guides/environments.md#环境变量-schema)。 |
| `suffixes`                 | 环境 → suffix 映射；可选 | 产品身份的默认环境后缀。                                                                   |
| `artifacts.root`           | string；`artifacts`      | 相对于工作区根目录的产物目录，本身不启用产物交付。                                         |
| `artifacts.retention.keep` | 正整数；`5`              | 每个产品、环境、变体保留的产物集合数量。                                                   |

## Project

准备流程见[执行说明](../guides/execution.md#项目准备)，支持的配置文件名与类型生成见[构建工具接入](../guides/integrations.md#类型准备)。修改 `configFile` 不会修改 target 命令。

| 字段         | 类型／默认值                    | 作用                                                  |
| ------------ | ------------------------------- | ----------------------------------------------------- |
| `root`       | string；`.`                     | 相对于工作区根目录的项目目录，也是命令工作目录。      |
| `targets`    | Target 映射；必填               | 项目命令；内置目标名只提供默认值，不自动提供命令。    |
| `prepare`    | string 或非空 string 数组；可选 | 每次调用、每个项目最多执行一次的有限准备命令。        |
| `configFile` | string；可选                    | 相对于项目根目录的宿主配置，仅用于 `matrix prepare`。 |

## Product

CLI 使用产品 key；稳定产品 ID 可以与 key 不同。

| 字段           | 类型／默认值             | 作用                                           |
| -------------- | ------------------------ | ---------------------------------------------- |
| `variants`     | Variant 映射；必填       | 属于当前产品的变体 key，每个条目引用一个项目。 |
| `id`           | string；产品 key         | 稳定产品 ID。                                  |
| `name`, `slug` | string；产品 key         | 展示名称及文件系统相关身份。                   |
| `appId`        | string；可选             | 应用标识。                                     |
| `version`      | SemVer string；可选      | 发布版本，见[产品发布版本](#产品发布版本)。    |
| `env`, `$env`  | 可选                     | 产品环境值及分环境覆盖。                       |
| `suffixes`     | 环境 → suffix 映射；可选 | 产品级身份后缀。                               |

## Variant

Variant 可以是项目 key 字符串，如 `web: 'web'`，或对象。Variant 不单独声明 `env`、`$env` 或 `envSchema`；应用差异应放在产品环境值中，必要时拆分项目或产品。

| 字段                    | 类型／默认值             | 作用                                 |
| ----------------------- | ------------------------ | ------------------------------------ |
| `project`               | string；必填             | 已存在的项目 key。                   |
| `name`, `slug`, `appId` | string；继承产品         | 当前变体的身份覆盖。                 |
| `version`               | SemVer string；继承产品  | 变体发布版本。                       |
| `suffixes`              | 环境 → suffix 映射；可选 | 变体级身份后缀。                     |
| `targets`               | 覆盖映射；可选           | 覆盖项目目标，或添加带命令的新目标。 |

## Target 覆盖

对象覆盖保留未指定的项目目标字段；`readyWhen`、`artifacts` 与原有设置合并。显式提供的 `dependsOn` 数组替换原依赖列表，因此 `dependsOn: []` 可以移除继承依赖。字符串或字符串数组覆盖会替换整个目标并重新应用目标名默认值，不保留原依赖、产物或就绪探测设置。

例如 `build: { command: 'pnpm build:desktop' }` 保留原 build 设置，而 `build: 'pnpm build:desktop'` 会重置它们。新增的对象目标必须提供 `command`。

## Target

目标支持命令字符串、按顺序执行的非空字符串数组或对象；命令均须非空。命令通过系统 shell 在项目根目录执行，引号语法及可用命令取决于平台。持续目标不支持命令数组。各内置目标的默认值见[目标默认值](../guides/execution.md#目标和默认值)。

| 字段         | 类型／默认值                                      | 作用                                            |
| ------------ | ------------------------------------------------- | ----------------------------------------------- |
| `command`    | string 或 string 数组；必填                       | 命令或顺序执行的步骤。                          |
| `prepare`    | boolean；除非为 `false`，否则允许准备             | 仅为当前目标跳过项目准备。                      |
| `continuous` | boolean；由目标名决定                             | 持续服务，而非有限任务。                        |
| `nodeEnv`    | `development`、`production`、`test`；由目标名决定 | 生成的 `NODE_ENV` 和 `MATRIX_NODE_ENV`。        |
| `readyWhen`  | 端口探测；可选                                    | 下游请求就绪条件时使用的探测。                  |
| `dependsOn`  | 依赖数组；`[]`                                    | 先执行同一产品中的其他变体。                    |
| `outputDir`  | string；`dist`                                    | 相对于项目根目录的输出目录。                    |
| `artifacts`  | 对象；默认不配置                                  | 为有限目标启用产物交付；`{}` 表示启用默认设置。 |

## 就绪探测

探测配置在被依赖的服务上，而不是消费它的目标上：

| 字段      | 类型／默认值         | 作用                          |
| --------- | -------------------- | ----------------------------- |
| `type`    | 必填 `'port'`        | 当前仅支持 TCP 端口就绪探测。 |
| `port`    | 整数 `1–65535`；必填 | 必须能接受 TCP 连接的端口。   |
| `host`    | string；`127.0.0.1`  | 探测主机。                    |
| `timeout` | 正整数；`30000`      | 最长等待时间，单位毫秒。      |

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: {
          command: 'pnpm dev',
          readyWhen: { type: 'port', host: '127.0.0.1', port: 5173, timeout: 30_000 },
        },
      },
    },
  },
  products: { app: { variants: { web: 'web' } } },
})
```

端口可连接不代表 HTTP/API 健康，也不证明端口属于该进程。未配置 `readyWhen` 时，`ready` 依赖在进程启动后直接继续，不执行探测；`matrix doctor` 会对此警告。没有下游依赖的服务不会因为配置探测而自动进行全局启动检查。

## 依赖

使用 `dependsOn: ['web']`，或 `dependsOn: [{ variant: 'web', target: 'build', condition: 'completed' }]`。

| 字段        | 类型／默认值           | 作用                                                         |
| ----------- | ---------------------- | ------------------------------------------------------------ |
| `variant`   | string；必填           | 同一产品内的变体 key，不是项目 key。                         |
| `target`    | string；当前目标名     | 在依赖变体上执行的目标。                                     |
| `condition` | `ready` 或 `completed` | **被依赖目标**持续运行时默认 `ready`，否则默认 `completed`。 |

依赖递归展开并先于消费目标执行；循环、缺失变体或目标均报错。`--variant` 选择入口变体，不移除它们的依赖。对持续服务使用 `completed` 会等待服务退出，通常不合适。

## 产物设置

这些设置属于 target 的 `artifacts`；目的目录和保留数量属于根级 `artifacts`，见[产物交付](../guides/execution.md#产物交付)。

| 字段     | 类型／默认值                      | 作用                                         |
| -------- | --------------------------------- | -------------------------------------------- |
| `mode`   | `move`、`archive`、`both`；`move` | 移动目录、压缩归档，或移动并在其中放入归档。 |
| `format` | `zip` 或 `tar.gz`；`zip`          | 压缩格式；仅移动时不使用。                   |
| `clean`  | boolean；`true`                   | 有限目标执行前清理输出目录。                 |

## 身份后缀

每个 `suffixes.<environment>` 条目支持可选的 `name`、`slug`、`appId` 字符串：

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {},
  products: {},
  suffixes: {
    staging: { name: ' (Staging)', slug: '-staging', appId: '.staging' },
  },
})
```

当前环境的 suffix 字段按 `global < product < variant` 合并；更具体的同名字段覆盖前一级，不逐级拼接后缀。最终 suffix 在合并环境中的身份覆盖解析后只追加一次。例如 `com.example.app` 变为 `com.example.app.staging`。缺失的 `appId` 仍然缺失；suffix 不改变产品 key、稳定 ID 或发布版本。

## 产品发布版本

多个产品复用同一项目时，可以分别声明发布版本；变体也可以覆盖产品版本：

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    desktop: {
      root: './apps/desktop',
      targets: { build: 'pnpm build' },
    },
  },
  products: {
    alpha: {
      version: '2.0.0',
      variants: { desktop: 'desktop' },
    },
    beta: {
      version: '3.0.0',
      variants: { desktop: { project: 'desktop', version: '3.1.0-rc.1' } },
    },
  },
})
```

解析优先级为 `MATRIX_PRODUCT_VERSION > variant.version > product.version > 项目 package.json 的 version`。环境变量沿用全局／产品 `env`、`$env`、dotenv、Shell 的现有合并顺序。版本使用 SemVer（支持预发布与构建元数据），不拼接环境 identity suffix；无效的显式版本直接报错，不回退。

版本在生成执行计划时确定，同步写入任务 `version`、子进程的 `MATRIX_PRODUCT_VERSION` 和构建期 `matrix.product.version`，产物命名使用同一个值。Matrix 不修改源 `package.json`，也不自动修改应用打包器的版本配置。例如 electron-builder 可以通过 `extraMetadata: { version: process.env.MATRIX_PRODUCT_VERSION }` 使用该版本。

没有显式版本时读取所选项目的 `package.json`（不向父目录查找）。非产物任务允许文件或 `version` 字段缺失，此时不注入版本；启用产物交付的非持续任务必须解析到有效版本。已有显式版本时不要求项目提供 `package.json`。
