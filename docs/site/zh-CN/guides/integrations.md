# 构建工具接入

Matrix 提供统一的 Unplugin 工厂，以及各构建工具的入口。

## 支持范围

需要 Node.js `>=22.18.0`。以下宿主均为可选 peer dependency，由使用对应适配器的消费项目安装；仅使用 CLI 时无需安装。

| 宿主    | 包入口                 | 支持范围                               |
| ------- | ---------------------- | -------------------------------------- |
| Vite    | `@xova/matrix/vite`    | `^5.1.0`、`^6.0.0`、`^7.0.0`、`^8.0.0` |
| Rollup  | `@xova/matrix/rollup`  | `^2.68.0`、`^3.0.0`、`^4.0.0`          |
| Webpack | `@xova/matrix/webpack` | `^5.100.1`                             |
| esbuild | `@xova/matrix/esbuild` | `>=0.12.0 <0.29.0`                     |

Matrix 从消费项目解析宿主；Electron 类型准备使用 electron-vite 对应的 Vite。框架插件需要满足各自的宿主依赖。测试版本、组合与覆盖项目见[测试矩阵](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix)。

## Vite 接入

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

运行 `matrix prepare` 可在不执行业务目标的情况下生成 runtime 声明。选择 product 只决定处理哪些项目，不缩小共享契约的产品范围：每个 project + scope 都收集当前 `--env` 下引用该项目的所有产品和变体，实际根目录相同或重叠的项目会一起收集，不扫描其他环境。scope 仍放在构建插件配置中。

- 默认只检查 project root，按 `electron.vite.config.*` → `vite.config.*` 优先级匹配；多个匹配文件需要显式选择。可设置 `projects.desktop.configFile`，例如 `'config/electron.vite.config.ts'`，路径相对于项目根目录，文件名仍须符合支持的 JS/TS 配置规则。显式文件不存在、名称不支持或解析失败时直接报错。此设置控制类型收集，不修改 target 命令。
- 使用项目本地 Vite/electron-vite 解析真实配置钩子、`root`、`envDir`、`envPrefix`、`scope` 和 `types`。每个产品/变体都在独立进程中解析两种标准上下文：`MATRIX_TARGET=dev`、`command=serve`、`NODE_ENV=development`，以及 `MATRIX_TARGET=build`、`command=build`、`NODE_ENV=production`。遵循 dev/build 配置的 `nodeEnv` 覆盖，`mode` 始终为所选 Matrix 环境。Electron main/preload 按正常开发流程执行 build 配置钩子。产品身份和版本沿用执行计划的解析规则，包括后缀及覆盖。
- `matrix dev` 和 `matrix build` 在每个受影响项目的准备命令之后、目标启动之前收集一次；后续 Vite/electron-vite 插件使用完整契约，不再用当前产品的类型覆盖它。每个引用产品/变体的两种上下文都会执行配置代码和钩子，因此增加启动开销，并非无副作用的静态扫描。每次宿主解析限时 30 秒，不启动 Electron、开发服务器或打包。
- **输出边界：**协调的 prepare/dev/build 要求解析后的宿主 root 和声明输出都位于 `project.root` 内；支持嵌套宿主 root 和内部自定义输出。会解析符号链接（包括已存在的输出父目录）；越界或悬空链接在写入前报错。应将 `project.root` 设为实际共享宿主目录，通过 `project.configFile` 引用存放在其他位置的配置。外部自定义输出会被拒绝，独立使用时的显式类型生成不变。
- 公开字段在各自 project + scope 内合并。仅部分产品、变体或上下文存在的推断字段标记为 optional。显式 schema 类型、默认值、可选性及运行时校验语义保持不变；生成 schema 字段的声明不要求提供运行时值。运行时快照仍只有当前产品的值，保留公开前缀及 main/preload/renderer 隔离。
- 完成收集和校验后才写入：`matrix prepare` 覆盖所有受影响项目，dev/build 则以项目收集组为单位。重复 scope、输出/前缀冲突、scope 集合变化或配置失败均报错。工作区级收集/写入协调防止较窄契约相互覆盖。只有确认唯一标识的锁持有进程已退出时才自动恢复；不会因锁存在时间较长而替换仍存活或无法核实的持有者。超时后，必须先确认没有类型准备正在运行，才能手动删除提示的锁目录。单文件替换是原子的，多文件写入不是事务。契约从当前来源重新计算，不与旧声明取并集，因此删除字段/产品或合法清空配置会移除过时字段；不会自动删除废弃的输出文件本身。
- 显式 `matrix prepare` 中，没有支持的宿主配置时，回退到 Matrix 配置和公开环境变量键，在 `.matrix/types/matrix-runtime.d.ts` 生成通用声明。配置解析成功但未启用 Matrix 插件时也使用该回退。其他宿主和任意配置文件名不提供宿主感知的共享契约保证，无法发现其特定前缀及输出路径。自定义目标保留原有插件行为，不在 dev/build 协调保证范围内。收集时不解析 target 命令的 `--mode`、`--config` 等参数；实际插件若增加未收集字段或改变 scope、前缀、输出路径或 schema，会报错而非覆盖为较窄契约。

生成 `ImportMetaEnv` 和 `matrix.config` 声明时不写入环境值。`types: false` 关闭生成。显式 `matrix prepare` 不受 Vitest 默认抑制影响；自动 dev/build 收集保留该抑制，可通过显式 `types: true` 或对象形式开启。缺少上下文的保护及独立使用时的显式开启方式见[插件选项](../reference/plugins.md#插件选项)。将生成目录加入项目的 `tsconfig.json`：

```json
{
  "include": ["src", ".matrix/types"]
}
```
