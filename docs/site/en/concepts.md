# Core concepts

Matrix separates project directories, runnable products, and concrete actions. Start with these concepts, then use the [configuration reference](reference/configuration.md).

## Terms

| Concept | Purpose                                                                 |
| ------- | ----------------------------------------------------------------------- |
| Project | An application directory and its commands                               |
| Product | A runnable deliverable composed of variants                             |
| Variant | A product entry bound to a project                                      |
| Target  | A command such as `dev`, `build`, `preview`, `test`, or a custom target |

## Multiple variants

A product can run more than one project and express dependencies per target:

```ts
import { defineMatrixConfig } from '@xova/matrix'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: { command: 'pnpm dev', readyWhen: { type: 'port', port: 5173 } },
        build: 'pnpm build',
      },
    },
    desktop: {
      root: './apps/desktop',
      targets: { dev: 'pnpm dev', build: 'pnpm build' },
    },
  },
  products: {
    app: {
      variants: {
        web: 'web',
        desktop: {
          project: 'desktop',
          targets: {
            dev: { dependsOn: [{ variant: 'web', condition: 'ready' }] },
            build: { dependsOn: [{ variant: 'web', condition: 'completed' }] },
          },
        },
      },
    },
  },
})
```

`ready` is useful for continuous targets such as `dev`; `completed` is useful for one-shot targets such as `build`.

## Place configuration with its owner

- Reusable directories, commands, and shared preparation belong to a Project.
- Product identity, release versions, and backend differences belong to a Product.
- A Variant binds a project and adds only the identity/target overrides and dependencies it needs.
- Configuration environments and target Node modes are separate dimensions; see [environments and schemas](guides/environments.md).

Create the first product with the [quick start](getting-started.md), then explore multiple variants through the [framework-free example](https://github.com/xova-dev/matrix/blob/main/examples/basic/README.md). Matrix orchestrates existing project commands rather than scaffolding application frameworks.
