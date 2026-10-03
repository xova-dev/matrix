---
layout: home
title: Matrix
titleTemplate: false

hero:
  name: Matrix
  text: Configuration-driven workspace CLI
  tagline: Configure projects once. Develop, build, and package by product and environment.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Core concepts
      link: /concepts

features:
  - title: Reusable projects
    details: Define application commands once and assemble products from project-backed variants.
  - title: Explicit environments
    details: Layer product values and dotenv overrides, with typed public configuration in supported builds.
  - title: Controlled execution
    details: Coordinate readiness, ordered commands, shared preparation, and artifact delivery.
---

## Choose your path

- First integration: start with [installation and the quick start](./getting-started.md), then read [core concepts](./concepts.md).
- Multiple products or environments: use [environment layering and schemas](./guides/environments.md).
- Web or Electron integration: follow [build tool integration](./guides/integrations.md).
- CI and packaging: read the [CLI reference](./reference/cli.md) and [execution/artifact guide](./guides/execution.md).
- Looking up a field: open [configuration](./reference/configuration.md) or [plugin/runtime](./reference/plugins.md) reference.
- Diagnosing a failure: use the [troubleshooting guide](./guides/troubleshooting.md).

## Runnable examples

- [basic](https://github.com/xova-dev/matrix/blob/main/examples/basic/README.md): two projects without framework dependencies; readiness, environments, dependencies, and artifacts.
- [electron-web](https://github.com/xova-dev/matrix/blob/main/examples/electron-web/README.md): two Web products sharing Electron; scoped types, preparation, and real packaging.
- [Example setup and verification boundaries](https://github.com/xova-dev/matrix/blob/main/examples/README.md).

Contributing to Matrix? See [development and verification](./contributing.md).

Matrix orchestrates your existing project commands; it does not scaffold application frameworks or provide deployment-time runtime configuration.
