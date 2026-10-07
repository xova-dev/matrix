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

启动开发前运行 `matrix prepare`，即可为所选 product 生成 runtime 声明。scope 仍放在构建插件配置中，不需要在 `matrix.config` 重复声明。

- 默认仅检查 project root 中的文件，按 `electron.vite.config.*` → `vite.config.*` 的优先级匹配，不扫描子目录，也不向父目录查找。同一条选中规则匹配多个文件时需要显式选择。prepare 使用项目本地安装的宿主解析真实配置，包括配置钩子、`root`、`envDir`、`envPrefix`、`scope` 和 `types` 选项。Electron main/preload 分别生成声明，不启动 Electron、开发服务器或打包。
- 可直接设置 `projects.desktop.configFile`，例如 `'config/electron.vite.config.ts'`，路径相对于该 project root，优先于自动发现。文件名仍需符合内置规则（`electron.vite.config.*` 或 `vite.config.*`，使用 JS/TS 模块扩展名）。显式文件不存在、文件名不支持或解析失败时直接报错，不回退。`configFile` 仅控制 prepare，不修改 target 命令；无需额外配置 host。
- prepare 解析开发态配置（`serve`；Electron main/preload 按开发时实际流程执行 `build` 配置钩子），`NODE_ENV=development`，`mode` 为 Matrix `--env` 选择。每个 product/variant 在独立进程中解析，传入 `MATRIX_TARGET=prepare` 及 product key、project、variant。产品身份（ID/name/slug/appId，含后缀和覆盖）及版本复用执行计划的解析规则；未配置版本时允许 package version 缺失。这不是生产构建上下文；scope 和类型契约应与所选产品及 target 无关。
- 共享项目合并所选产品的公开字段名；schema 声明的字段不要求提供运行时值。重复 scope、输出/前缀冲突、scope 集合变化或配置解析失败时，Matrix 会在写入声明前报错。prepare 除执行已有项目准备命令外，还会执行配置代码和配置钩子，并不是无副作用的静态扫描。每次宿主解析限时 30 秒。
- 未显式指定配置且 project root 没有匹配文件时，保留原有通用生成方式，从 Matrix 配置和公开环境变量键生成 `.matrix/types/matrix-runtime.d.ts`。暂不支持其他宿主或任意配置文件名。宿主配置成功解析但未启用 Matrix 插件时，也沿用该通用方式（使用 Matrix 设置，不采用宿主特定前缀或 scope）；启用插件并设置 `types: false` 时不生成。不会自动删除旧声明文件。

prepare 和构建插件生成 `ImportMetaEnv`、`matrix.config` 类型时均不写入环境变量实际值。构建插件仍按当前构建最终配置生成声明；在 Vitest 环境默认不自动生成，可用 `types: true` 或 `types: { output: '...' }` 显式开启。显式运行 `matrix prepare` 不受 Vitest 默认值限制，但遵循 `types: false`。将生成目录加入各项目对应 `tsconfig.json`：

```json
{
  "include": ["src", ".matrix/types"]
}
```

所有适配器的选项、虚拟模块命名及字段见[插件与 runtime 参考](../reference/plugins.md)。
