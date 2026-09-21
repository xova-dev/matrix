# Basic example

This is a self-contained Matrix example with two projects and no framework dependency. It is
small enough to run locally, while covering the main configuration points used by a multi-target
application.

It demonstrates:

- reusable Web and Desktop projects
- the short target form (`test: 'node test.mjs'`)
- `dev`, `build`, `preview`, and `test` targets
- readiness checks for long-running targets
- product and variant `appId`, `name`, and `slug` values
- product-scoped `qa`, `staging`, and `production` environment variables
- environment-specific identity suffixes
- a variant dependency shared by `dev` and `build`
- ordered target commands and ZIP or moved build artifacts

The example uses the short `dependsOn: ['web']` form. Matrix selects `ready` for continuous
targets such as `dev` and `completed` for one-shot targets such as `build`.

The `qa` environment is product-scoped, so it appears after `app` is selected in the interactive
flow. The built-in environments are `development`, `staging`, and `production`; custom names can
be added under the product's `$env` object.

Build Matrix from the repository root first:

```bash
pnpm build
```

Then run the example:

```bash
cd examples/basic
pnpm run matrix
pnpm run doctor
pnpm run test
pnpm run plan
pnpm run build
pnpm run preview
```

`pnpm run matrix` starts the interactive Product → Variant → Target → Environment flow. The
other scripts pass explicit selections and are intended for repeatable non-interactive runs.

`pnpm run dev` starts the Web project first and starts the Desktop project after the Web port is
ready. Stop continuous commands with `Ctrl+C`.

The build command cleans both project `dist` directories first, creates a Web ZIP while retaining
the current Web output, and moves the Desktop output under `examples/basic/artifacts/app/staging/`.
