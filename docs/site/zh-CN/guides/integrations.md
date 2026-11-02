# 构建工具接入

Matrix 统一编排产品、variant、环境、任务、进程与产物。对外只有**原生接入**（环境变量与宿主 API）和**混合接入**（显式安装适配器，使用 Matrix 构建快照与配套类型）。两者都保留宿主原生 API；混合接入不要求同一字段同时使用两套 API，也不新增接入 mode 配置。

## 支持范围

需要 Node.js `>=22.18.0`。以下宿主均为可选 peer dependency，由使用对应适配器的消费项目安装；仅使用 CLI 时无需安装。

| 宿主    | 包入口                 | 支持范围                               |
| ------- | ---------------------- | -------------------------------------- |
| Vite    | `@xova/matrix/vite`    | `^5.1.0`、`^6.0.0`、`^7.0.0`、`^8.0.0` |
| Nuxt    | `@xova/matrix/nuxt`    | `^4.0.3`；Vite SSR / SPA               |
| Rollup  | `@xova/matrix/rollup`  | `^2.68.0`、`^3.0.0`、`^4.0.0`          |
| Webpack | `@xova/matrix/webpack` | `^5.100.1`                             |
| esbuild | `@xova/matrix/esbuild` | `>=0.12.0 <0.29.0`                     |

Matrix 从消费项目解析宿主；Electron 类型准备使用 electron-vite 对应的 Vite。框架插件需要满足各自的宿主依赖。测试版本、组合与覆盖项目见[测试矩阵](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix)。

隔离的历史 Webpack fixture 将 `schema-utils` 固定到仓库锁文件使用的 `4.5.0`，因为 `4.8.1` 要求 `webpack ^5.112.0`。严格 peer 检查继续启用；该固定仅用于测试，不是发布包的依赖覆盖，也不改变宿主支持范围。

## 原生 Vite 接入

不需要 Matrix 插件、虚拟模块或声明：

```ts
// matrix.config.ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: { typegen: false, targets: { dev: 'vite', build: 'vite build' } },
  },
  products: {
    app: {
      env: { VITE_API_BASE: 'https://api.example.test' },
      variants: { web: 'web' },
    },
  },
})
```

运行 `matrix dev app` 或 `matrix build app`，应用直接读取 `import.meta.env.VITE_API_BASE`。类型使用 Vite 自带的 `vite/client` 与应用自己的 `ImportMetaEnv` 扩展。公开前缀、字符串转换、内置模式标记和构建期替换都由 Vite 负责；只有其配置的公开前缀进入客户端，Matrix 不会在这条路径自动公开 `MATRIX_*` 或 `NUXT_*`。静态 Vite 产物不会在部署后重新读取环境变量。

`project.typegen: false` 跳过 Matrix 宿主发现/加载和全部 Matrix 类型准备，包括显式 `matrix prepare`、自动 dev/build 收集、通用 fallback 与重叠项目扩张；项目准备命令仍照常执行。省略时保留既有混合行为，不会静默迁移现有消费者。它不会删除旧声明，也不禁止手工安装的插件自行生成类型；选择原生接入时应移除插件/虚拟模块导入及过时的 `.matrix` 引用。`target.prepare: false` 只跳过项目命令，不能替代这一选项。

## 混合 Vite 接入

```ts
import matrix from '@xova/matrix/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [matrix()],
})
```

Vite 适配器会保留最终解析出的 envPrefix，并自动加入 Matrix 保留的 MATRIX_ 前缀。它读取 Vite 最终的 config.env，通过 virtual:matrix/runtime 提供结构化构建上下文：

```ts
import { matrix } from 'virtual:matrix/runtime'

matrix.environment
matrix.product.name
matrix.product.appId
matrix.config.apiBase

matrix.isDevelopment
matrix.isProduction
matrix.isTest
```

这些模式标记由 Matrix 解析后的 `nodeEnv`（`development`、`production` 或 `test`）生成，是构建时快照值。`dev`、`build`、`dist`、`preview` 等 Matrix 专属目标仍应通过 `matrix.target` 判断。

同一套工厂也可以通过 @xova/matrix/rollup、@xova/matrix/webpack 和 @xova/matrix/esbuild 使用。虚拟模块是构建时快照，不是部署后可变的 runtime config；只有宿主构建工具已通过前缀暴露的变量，才会进入 matrix.config。

## 原生 Nuxt 接入

Nuxt 自己管理 `runtimeConfig` 契约、默认值、生成类型及应用 API。Matrix 在这条路径只给原生命令提供匹配的环境变量，不安装 Module、Vite 插件、虚拟模块或声明。常规 Nuxt 应用仍推荐原生接入，但不是强制选择。Nuxt 4.0.3 和 4.6.3 的隔离原生命令验证覆盖准备阶段，生产 runtimeConfig 和默认 Nitro Node server 由混合 SSR 主链验收；不代表每次包验收都验证原生 SPA 生成，也不逐个认证所有 Nuxt minor、builder 或 Nitro preset。

```ts
// nuxt.config.ts（也可以放在共享 Nuxt Layer）
export default defineNuxtConfig({
  runtimeConfig: {
    privateToken: '',
    public: { apiBase: '' },
  },
})
```

```ts
// matrix.config.ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      typegen: false,
      targets: { dev: 'nuxt dev', build: 'nuxt build', generate: 'nuxt generate' },
    },
  },
  products: {
    app: {
      env: { NUXT_PUBLIC_API_BASE: 'https://api.example.test' },
      variants: { web: 'web' },
    },
  },
})
```

开发/构建时通过 Matrix 运行原生目标：`matrix dev app`、`matrix build app` 或 `matrix generate app`。按应用原有流程运行 `nuxt prepare` / `nuxt typecheck`。对这个项目，`matrix prepare` 仍执行 `project.prepare`，但不加载 Nuxt、不生成 Matrix 类型。`configFile` 是 Matrix 混合类型收集设置，不负责选择 Nuxt 命令的配置，这里无需填写。Matrix 不推断框架，不解析命令参数。

应用组件只使用原生 API：

```ts
const config = useRuntimeConfig()
const apiBase = config.public.apiBase
```

Nitro server handler 使用 `useRuntimeConfig(event)`；只有 `public` 字段暴露到客户端。`public.apiBase` 对应 **`NUXT_PUBLIC_API_BASE`**，`privateToken` 对应 **`NUXT_PRIVATE_TOKEN`**。字段与默认值只在 Nuxt 配置或 Layer 声明，不把 `runtimeConfig` 复制到 Matrix，也不引入第二套读取 API。`NUXT_*` 不会自动成为 Matrix 公开前缀。共享业务包通过参数或回调获取所需值，不必绑定任何一套框架 API。

生产私密值不要写入构建默认值或产品构建输入。Node 服务以空/非敏感默认值构建，部署时注入 `NUXT_PRIVATE_TOKEN`、`NUXT_PUBLIC_API_BASE`，直接运行同一份 `.output/server/index.mjs`，无需经过 Matrix。Nuxt/Nitro 在服务启动时应用匹配覆盖，同一产物可使用不同部署值而无需重建。不要通过不同名称的 `process.env` 默认值模仿这一映射；server handler 也不能返回私有字段。

静态 SPA（`ssr: false`、`nuxt generate`）的公开值固定在生成的 payload/assets 中；同一批静态文件即使部署环境变量变化也**不会**自动覆盖。需要按产品/环境重新构建，或显式设计外部配置服务。SSR、preset、编译期分支消除等开关归构建配置，不应当作可变 runtimeConfig 字段。Nuxt 保留自身构建模式与环境语义；Matrix 环境只选择 Matrix 输入，不替代 Nuxt 的模式系统。

## 混合 Nuxt SSR 与 SPA 接入

多个产品共用同一 Nuxt 应用、需要 Matrix 构建快照时，显式安装可选 Module：

```ts
// nuxt.config.ts（也支持共享 Layer）
export default defineNuxtConfig({
  modules: ['@xova/matrix/nuxt'], // 默认 SSR；ssr: false 也支持 SPA
  nitro: { preset: 'node-server' },
})
```

保留 `project.typegen` 启用（省略即可），目标仍是原生命令，如 `dev: 'nuxt dev'`、`build: 'nuxt build'`（静态 SPA 可用 `nuxt generate`）。通过 `matrix dev app` / `matrix build app` 运行。Module 安装虚拟模块并接入类型引用，不要同时安装 Matrix Vite 插件；Layer 与应用重复声明 Module 使用 Nuxt 原生去重。

```ts
import { matrix } from 'virtual:matrix/runtime'

const apiBase = matrix.config.apiBase // NUXT_PUBLIC_API_BASE，构建时固定
const productName = matrix.product.name
```

也可注册 `modules: ['@xova/matrix/nuxt']`，将选项放在有类型支持的顶层 `matrix: { ... }`。Layer 与应用的选项遵循 Nuxt 原生优先级和去重，不要重复填写冲突的内联选项。

### 公开字段与选项

业务字段默认公开 **`['VITE_', 'NUXT_PUBLIC_']`**，兼容共享的 Vite 业务变量，但绝不公开 Nuxt 宽泛的 `NUXT_` 前缀。这只是 Nuxt 适配器默认值，普通 Vite 适配器不会额外公开 `NUXT_PUBLIC_`。Matrix 既有安全产品元数据仍可用，内部元信息及私密变量仍被排除。

Module 显式 `envPrefix` 会**替换**业务默认数组：`envPrefix: 'NUXT_PUBLIC_'` 不再包含 `VITE_`。`scope`、`inline`、`types: { output }` 遵循适配器契约。例如 `modules: [['@xova/matrix/nuxt', { scope: 'web', envPrefix: ['NUXT_PUBLIC_', 'APP_'], types: { output: 'types/matrix.d.ts' } }]]` 对应 `virtual:matrix/runtime/web`。不要在显式覆盖里加入私密前缀。

Nuxt 中不同公开变量名不能映射到同一 `matrix.config` 字段，即使值相同也会报错；类型收集还会检查分别出现在不同产品的别名。例如 `VITE_API_BASE` 与 `NUXT_PUBLIC_API_BASE` 都映射到 `matrix.config.apiBase`，诊断只列出原始键与字段，不输出值；camelCase 别名和仅在 schema 声明的字段同样检查。请跨产品统一原始变量名，或用显式前缀排除别名。Matrix 对**同一**变量名的产品／环境覆盖仍正常支持。这两个前缀都不会自动复制到或声明在 Nuxt `runtimeConfig` 中，原生契约保持独立。

### 类型所有权与准备

类型由 Nuxt `rootDir` 唯一持有，自定义 `srcDir` 不会另写声明；Module 自动加入 Nuxt 类型引用。准备阶段解析真实 Nuxt dev/build 客户端配置，合并全部关联产品并保留跨产品可选字段，在启动 Vite 服务器或编译应用前停止。

客户端契约为唯一权威：实际 dev/build 还会解析服务端管线，验证公开前缀与完整快照一致后复用同一快照。仅服务端新增、移除或改值的公开配置会明确报错，不会静默扩大或覆盖类型；私有值使用原生服务端配置。Nuxt 准备不会递归调用 Matrix 准备；输出必须位于 `project.root` 内。环境变化需要重启或重建，源码 HMR 不刷新环境快照。

`project.typegen: false` 关闭 coordinator 的宿主发现与类型生成，不等于关闭虚拟模块。仅需混合运行时时，还要显式设置 Module `types: false`；否则构建明确报错，避免暗中推翻关闭类型的意愿。`nuxt prepare` / `nuxt typecheck` 可使用之前准备的类型；脱离 Matrix 上下文直接运行 Nuxt dev/build 会得到诊断。没有安装 Module 的原生应用不受影响。

包验收在两个已测试的 Nuxt 端点使用同一条混合 SSR 应用主链，显式设置应用 `rootDir`，接入本地、已安装包和受控 HTTP 远程 Layer。两个产品构建检查客户端资源、SSR 和直接 Node Nitro 启动；部署时 runtimeConfig 覆盖不改变 Matrix 快照或构建产物。无 Module 的原生接入、`ssr: false`、配置后缀和显式路径保留真实 prepare/typecheck/load 轻量回归，不重复执行生产构建。HTTP/SSR 检查不等于浏览器 hydration 或交互验收。

HTTP 服务验收分别报告有界的启动、验证和回收阶段；每次请求及响应体读取也有独立期限。回收仅针对自身启动的进程树（POSIX 进程组 SIGTERM；Windows `taskkill /T /F`，不代表 Matrix 优雅取消）。请求或关闭失败不会因强制清理成功而转为通过，原始错误和有限服务诊断仍会保留。

每个包验收 profile 都保留两个 Nuxt 端点、混合 SSR/Node 部署主链、严格 Matrix 契约类型检查，以及同目录显式配置、根外配置和目录 junction Layer 路径。full 额外检查 Nuxt 应用类型、默认发现的后缀排列和选项/碰撞拒绝；daily/platform 共用平台敏感核心集。共享 runtime/类型生成测试仍在每个 CI 平台覆盖别名输入组合。Layer 选择通过一次自动准备的 Matrix 目标执行原生加载，保留 Matrix 上下文和失败保护检查，不重复收集相同声明契约。

原生复现中，Nuxt 4.0.3 在 `.ts` 根配置、自定义 `srcDir` 和对象式远程 Layer 组合下，同进程重复加载配置会将默认应用根目录变为远程缓存目录，此过程没有 Matrix 参与；相同复现在 4.6.3 保持根目录不变。混合包验收 fixture 显式设置 `rootDir`，不代表受影响的默认根目录组合已通过。

### 运行时与部署边界

Module **不代理、复制、推断或同步** `runtimeConfig`。原生 `useRuntimeConfig()` 始终保留，可独立管理其他字段；同一字段应选择一个权威消费口，Matrix 快照不是部署覆盖。是否同时使用两套 API 由应用决定。

SSR 应用导入与客户端导入使用同一公开构建快照，hydration 前的 SSR HTML 即包含所选产品值。最终 Node 产物无需 Matrix 进程即可直接启动；部署环境不会替换 Matrix 快照，独立声明的原生 `runtimeConfig` 仍可接受部署覆盖。不要将服务端秘密放进 Matrix 公开前缀：公开快照字段可能进入 HTML、客户端 JavaScript 和 payload。

`server/api` 与 Nitro 插件中直接导入还单独支持 **`node-server` preset**（及其本地开发管线），复用同一 scope、快照与类型所有者。这与 SSR 应用支持是两个边界。其他 Nitro preset 直接导入 Matrix 会明确报错，请改用原生 `runtimeConfig`。

### 支持的管线

混合接入支持声明范围 `^4.0.3` 内的 Nuxt Vite builder，独立包消费者验证 4.0.3 和 4.6.3 的 SSR、静态 SPA 与 Node Nitro，并非逐个验证中间 minor 或部署平台。其他 builder 和 `experimental.viteEnvironmentApi` 会明确拒绝，包括仅使用运行时的接入。

## 不可变快照与 tree shaking

现有 import 同时也是静态优化入口，无需全局变量或 `import.meta.matrix`：

```ts
import { matrix } from 'virtual:matrix/runtime'

if (matrix.isDevelopment) {
  void import('./dev-tools')
}
```

Matrix 为每个插件／构建上下文解析一份不可变快照。共享的 Oxc 转换识别匹配虚拟模块的具名导入，把已知、实际存在的标量属性读取替换为字面量，支持导入重命名、点访问和字符串字面量下标。宿主随后可以删除不可达分支及其专属动态导入 chunk。Vite、Rollup、esbuild、Webpack 均有实际构建测试；Electron main/preload 通过 electron-vite 使用同一转换。其他宿主及框架 loader 组合不自动获得兼容性承诺。带副作用的静态导入仍遵循宿主正常的模块语义。

动态 key、解构、对象别名、namespace import 和重导出继续使用虚拟模块回退，不承诺内联。未知、继承或缺失的 optional 属性也保留运行时读取。允许传递、枚举快照；只有当前 scope 的公开字段参与替换，boolean／number 保留原生标量类型。每个编译上下文使用一个 scope；尤其是 esbuild 不会在同一源码模块上串联多个独立注册的插件实例的转换。

所有适配器都只加载精确匹配的 Matrix 虚拟模块 ID。普通 JS/TS 文件可以进行静态替换；其他资源保留宿主原行为，除非属于下述明确支持的情况。Webpack 还会检查实际模块类型，即使资源以 JS 为扩展名，也不会改写其内容。

Vite 配合官方 `@vitejs/plugin-vue` 时，也支持已编译 Vue 脚本中的静态读取，包括 `<script setup lang="ts">` 和普通 `<script>`。Matrix 复用 Vue 编译结果及 sourcemap，不自行解析 SFC；客户端生产构建、SSR 和开发管线均有测试。template/style/custom block、raw/url 导入仍不参与转换；其他框架及自定义 Vue 查询格式不自动获得支持。

esbuild 仅处理 file namespace；import attributes 和非脚本 loader 交由原宿主处理。**必需的源码加载插件应注册在 Matrix 之前**：其接管的文件使用不可变 runtime 回退，未接管的文件仍可由 Matrix 内联。如果后续 loader 必须处理同一源码，则不支持将 Matrix 放在前面，因为 esbuild 采用首个返回的内容，不会串联 loader：

```ts
plugins: [customSourceLoader(), matrix()]
```

复杂 loader 组合可使用 `matrix({ inline: false })` 关闭 Matrix 的源码转换。该选项适用于所有适配器，默认为 `true`；虚拟模块、公开字段和 scope 边界、冻结快照及类型生成不受影响。关闭后不再提供 Matrix 的构建期写入诊断，修改仍受运行时冻结保护，也不保证开发分支及专属 chunk 被删除。esbuild 此时不会注册 Matrix 的源码 loader，可使用 `plugins: [matrix({ inline: false }), customSourceLoader()]`，但其他插件之间仍遵循宿主自身的顺序规则。

没有实际 Matrix 替换的文件继续交给后续 loader。Vite/Rollup 和 Webpack 保留上游 sourcemap；esbuild 合并有效的 inline map，外置或不支持的 map 则交回宿主 loader，不保证内联。上述映射链路均有实际构建测试。

**兼容性变化：**根对象、`product` 和 `config` 在类型上只读，在运行时冻结。可识别的直接赋值、自增减和删除会报构建错误；间接修改由冻结对象阻止（严格模式赋值抛错，`Reflect.set` 返回 `false`）。需要可变应用状态时，应复制相关值到应用自己的对象。开发和生产均不再支持修改 Matrix 快照。

值在插件解析环境时确定，不在构建产物启动时重新读取。修改环境后应重启开发／构建上下文；`matrix prepare` 仍只生成契约，不嵌入环境值。不同产品和 scope 使用独立快照。

## Electron scope

Electron 多配置时为每个构建指定 scope，避免 main、preload、renderer 互相覆盖：

```ts
import matrix from '@xova/matrix/vite'
import { defineConfig } from 'electron-vite'

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

electron-vite 必须支持所选 Vite。类型准备组合与真实 Electron 应用验收是两项独立检查，版本及覆盖范围见[测试矩阵](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix)。

## 类型准备

运行 `matrix prepare [product]` 可生成声明而不执行业务目标。product 只选择项目；每个共享 project + scope 都包含所选 `--env` 下引用它的所有产品和变体，不扫描其他环境。实际根目录相同或重叠的混合项目一起收集，`typegen: false` 的项目不会加入。`matrix dev` 和 `matrix build` 在项目准备之后、目标启动之前收集。

### 配置与兼容性

#### 自动发现

只检查项目根目录，按 `nuxt.config.*` → `electron.vite.config.*` → `vite.config.*` 优先级匹配，支持 `.js`、`.mjs`、`.cjs`、`.ts`、`.mts`、`.cts` 扩展名；多个匹配文件需要显式选择。`typegen: false` 的原生项目跳过发现，也跳过 doctor 的宿主配置检查。

#### 显式 configFile 与 configHost

可设置相对于项目根目录的 `projects.desktop.configFile`（例如 `'config/electron.vite.config.ts'`）精确选择文件。标准文件名自动推导宿主，包括显式选中的无扩展名 `nuxt.config`、`electron.vite.config` 和 `vite.config`；这些无扩展名文件不参与自动发现。只有无法识别的名称才需同时设置 `configHost: 'vite'`、`'electron-vite'` 或 `'nuxt'`，例如 `{ configFile: 'build/custom.mjs', configHost: 'vite' }`。

识别宿主不代表新增文件格式支持：所选文件（包括无扩展名配置）是否被接受，由消费者的宿主加载器及版本决定。Matrix 不从命令或已安装依赖猜测宿主。宿主与标准文件名不一致、显式文件不存在或配置解析失败时直接报错。这些设置不修改 target 命令；scope 仍放在构建插件配置中。

#### Nuxt Layer

Nuxt Layer 保留原生 `nuxt.config` 发现规则，不继承主应用配置的扩展名或显式路径。Nuxt 负责解析本地、嵌套、已安装包和远程 Layer，合并选项并执行 Modules/hooks，再由 Matrix 收集最终客户端 Vite 配置。精确选择根配置不会改写每层配置名，也不替换 Nuxt 的下载、认证或安装行为；消费者应自行安装远程 Layer 所需依赖，Matrix 不负责提供。

#### 输出边界与收集范围

解析后的宿主 root 和声明输出必须位于 `project.root` 内，符号链接也不能越界；越界或悬空链接在写入前报错。迁移时，将 `project.root` 设为共享宿主目录，通过 `configFile` 引用其他位置的配置。支持嵌套宿主 root 和内部自定义输出，拒绝外部输出。独立使用时的显式生成不变。

共享收集支持标准 Vite/electron-vite 及混合 Nuxt SSR/SPA dev/build 上下文；自定义目标和其他宿主保留原有插件行为。收集不解析 target 命令的 `--mode`、`--config` 等参数；实际插件若增加未收集字段或改变 scope、前缀、输出路径或 schema，会报错而非覆盖契约。

#### 回退行为

未设置 `project.typegen: false` 时，显式 `matrix prepare` 在没有支持的配置，或配置解析成功但未启用 Matrix 插件时，回退到 Matrix 设置和公开环境变量键，在 `.matrix/types/matrix-runtime.d.ts` 生成声明。此回退无法发现宿主特定前缀或输出路径。

### 契约行为

- 项目本地宿主为每个产品/变体解析 dev（`MATRIX_TARGET=dev`、`command=serve`、`NODE_ENV=development`）和 build（`MATRIX_TARGET=build`、`command=build`、`NODE_ENV=production`）两种上下文。遵循配置的 `nodeEnv` 覆盖；Vite/electron-vite 的 `mode` 为所选 Matrix 环境。Electron main/preload 使用正常开发流程的 build 钩子。产品身份和版本沿用执行计划规则。
- 两种上下文都会执行配置代码和钩子，增加启动开销；每次解析限时 30 秒。收集本身不启动 Electron、服务器或打包。
- 仅部分产品、变体或上下文存在的推断公开字段标记为 optional。显式 schema 类型、默认值、可选性及校验不变；schema 字段不要求提供运行时值。运行时值仍只属于当前产品，保留公开前缀和 Electron scope 隔离。
- 重复 scope、输出/前缀冲突、scope 集合变化或配置失败均在写入前报错：`prepare` 覆盖所有受影响项目，dev/build 以收集组为单位。契约从当前来源重建，因此删除字段/产品或清空配置会移除过时字段；不会自动删除废弃的输出文件。

声明只包含 `ImportMetaEnv` 和 `matrix.config` 类型，不写入环境值。`types: false` 关闭生成。显式 `matrix prepare` 不受 Vitest 抑制；自动 dev/build 收集遵循[插件默认行为及显式开启方式](../reference/plugins.md#插件选项)，包括 Vitest 抑制和缺少上下文的保护。将生成目录加入项目的 `tsconfig.json`：

```json
{
  "include": ["src", ".matrix/types"]
}
```
