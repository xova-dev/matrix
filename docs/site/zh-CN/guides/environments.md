# 环境与 schema

## 环境

所有产品共享的变量放在顶层 `env` 和 `$env`。如果不同产品复用相同项目但连接不同后端，则将产品专属变量放在产品内部：

```ts
import { defineMatrixConfig, defineMatrixEnv } from '@xova/matrix'

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

Matrix 会向 target 子进程注入以下执行上下文变量；项目准备使用更窄的项目级上下文，见[项目准备](execution.md#项目准备)。

```text
MATRIX_ENV_NAME
MATRIX_TARGET
MATRIX_PRODUCT_KEY
MATRIX_PRODUCT_ID
MATRIX_PRODUCT_NAME
MATRIX_PRODUCT_SLUG
MATRIX_PRODUCT_APP_ID
MATRIX_PRODUCT_VERSION
MATRIX_VARIANT
MATRIX_PROJECT
MATRIX_NODE_ENV
NODE_ENV
```

`MATRIX_ENV_NAME` 是当前选择的 Matrix 配置环境，可以是 `staging`、`qa` 等自定义名称。`NODE_ENV` 表示目标进程的运行模式：`dev` 使用 `development`，`test` 使用 `test`，`build`、`dist` 和 `preview` 使用 `production`。`MATRIX_NODE_ENV` 是同一个生成值的 `MATRIX_` 前缀版本，用于让 Vite 的前缀过滤 `config.env` 将它带入构建期 runtime module。因此 staging 构建通常会同时得到 `MATRIX_ENV_NAME=staging`、`MATRIX_NODE_ENV=production` 和 `NODE_ENV=production`。只有最终解析出的产品 identity 配置了 `appId` 时，才会注入 `MATRIX_PRODUCT_APP_ID`；环境 suffix 会在导出前生效。

产品级环境变量会为每个产品独立解析。这样多个产品可以复用同一个 Desktop 项目，同时连接不同的 Web 变体或服务。

支持自定义环境名称。使用相同的 helper 定义，并在 CLI 中显式传入环境名：

```ts
import { defineMatrixConfig, defineMatrixEnv } from '@xova/matrix'

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

## 环境变量 schema

在根级 `envSchema` 集中声明类型、默认值和可选性；产品仍通过 `env` / `$env` 覆盖值，不声明自己的 schema，也不从覆盖值推断类型：

```ts
import { defineMatrixConfig, defineMatrixEnv } from '@xova/matrix'

export default defineMatrixConfig({
  envSchema: {
    VITE_RENDERER_MODE: { type: 'enum', values: ['remote', 'bundled'], default: 'remote' },
    VITE_CLOUD_SUBMISSION_ENABLED: { type: 'boolean', default: false },
    VITE_RETRY_COUNT: { type: 'number', default: 3 },
    VITE_LABEL: { type: 'string', optional: true },
  },
  projects: { web: { targets: { build: 'vite build' } } },
  products: {
    app: {
      env: { VITE_RENDERER_MODE: 'bundled' },
      variants: { web: 'web' },
    },
  },
})
```

`defineMatrixConfig()` 按根级声明约束全局、产品及其 `$env` 的输入，enum 默认值也必须属于 `values`。默认值使用原生类型；boolean 的覆盖值接受布尔值或精确的 `'true'` / `'false'`，number 接受有限数字或十进制／科学计数法字符串，不接受空白、空字符串、十六进制、NaN 或 Infinity。string 不做隐式转换，enum 按字符串精确匹配。

覆盖顺序保持为 `schema default < global env/$env < product env/$env < dotenv < process.env`。默认值只补缺失字段；最终覆盖值非法会报错，不回退默认值，错误只标明字段和期望类型，不输出值。未声明字段保持原有行为。

通过 Matrix 启动构建后，`matrix.config.cloudSubmissionEnabled` 为 boolean、`retryCount` 为 number、`rendererMode` 为 enum 字面量联合类型。原始 `process.env` 和生成的 `ImportMetaEnv` 字段仍为 string。`optional: true` 且无默认值的缺失字段不出现在 runtime 对象中，生成的属性带 `?`；有默认值则生成必有属性。`matrix prepare` 和构建插件均使用同一份声明生成类型，不把实际值或非公开字段写入类型文件。

required 的检查范围是当前构建插件消费的公开前缀：例如 Web 使用 `VITE_` 时，不要求缺失的 `MAIN_VITE_*`。计划中的任务和准备命令会校验各自最终环境中的已有值并应用默认值，不全局要求所有字段都存在；类型生成本身不要求字段有值。Vite 在最终配置解析完成时校验当前 `envPrefix` 的字段，其他适配器在构建启动时校验；不依赖应用导入 runtime 模块，关闭类型生成也不会跳过校验。同一前缀内的 required 声明适用于所有消费该前缀的项目，项目专属字段应使用独立前缀或标记 optional。非公开字段的已有值也会校验，但缺失检查由应用负责。`scope` 继续隔离模块与类型文件，公开范围仍由 `envPrefix` 决定，schema 不扩大它。不同字段若映射到同一个公开属性且涉及 schema，直接报错，避免类型与值不一致。

schema 通过 Matrix 的内部子进程上下文传给适配器，不会进入 `matrix.config`；没有通过 Matrix 启动的独立构建保持原有字符串行为。`MATRIX_*`、`__MATRIX_*` 和 `NODE_ENV` 为保留字段，不能声明在 schema 中。plan 输出仍可能包含已声明变量的实际值，不应公开粘贴。
