# Basic example

This is a Matrix workspace example with two projects and no framework dependency. It is
small enough to run locally, while covering the main configuration points used by a multi-target
application.

It demonstrates:

- a Web project and a simulated Desktop project (no Electron)
- the short target form (`test: 'node test.mjs'`)
- `dev`, `build`, `preview`, and `test` targets
- readiness checks for long-running targets
- product and variant `appId`, `name`, and `slug` values
- an explicit product release version shared by both variants
- product-scoped `qa`, `staging`, and `production` environment variables
- environment-specific identity suffixes
- a variant dependency shared by `dev` and `build`
- ordered target commands and ZIP or moved build artifacts

The example uses the short `dependsOn: ['web']` form. Matrix selects `ready` for continuous
targets such as `dev` and `completed` for one-shot targets such as `build`.

The `qa` environment is product-scoped, so it appears after `app` is selected in the interactive
flow. The built-in environments are `development`, `staging`, and `production`; custom names can
be added under the product's `$env` object.

Install workspace dependencies and build Matrix from the repository root first:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm check:examples
```

Then run the example:

```bash
cd examples/basic
pnpm run doctor
pnpm run test
pnpm run plan
pnpm run build
```

The commands above are finite and non-interactive. `test` checks the injected product,
version and API context; the ordered Desktop build also checks its output and the
dependent Web output before Matrix moves the Desktop artifact.

Start a continuous command separately, and stop it with `Ctrl+C`:

```bash
pnpm run preview
# Or: pnpm run dev
```

Preview serves the existing Web `dist/index.html` at `http://127.0.0.1:5311`. It fails
if that file is missing and does not rebuild or change its embedded environment.
Both the build and preview scripts select `staging`. Desktop has no preview target:
its text output is moved into the artifact directory.

`pnpm run matrix` starts the interactive Product → Action → Configuration flow.
You can also invoke the installed CLI directly, for example `pnpm exec matrix doctor`.
The config imports `@xova/matrix`, backed by `workspace:*`; it never imports internal
source files. Rebuild Matrix when changing the library.

`pnpm run dev` starts the Web project first and starts the Desktop project after the Web port is
ready. Stop continuous commands with `Ctrl+C`.

This example is for manual exploration. Automated CLI shutdown acceptance runs through the
repository-root `pnpm test:pack` against the installed package with isolated, port-free fixtures,
not these example servers. It does not replace acceptance in a real interactive TTY.

The build command cleans both project `dist` directories first, creates a Web ZIP while retaining
the current Web output, and moves the Desktop output under `examples/basic/artifacts/app/staging/`.
Both variants inherit `products.app.version` (`0.1.0`) for their runtime context and artifact names.
Their project directories do not need a `package.json`; the example-root package version is not
used as a fallback for these nested projects.
