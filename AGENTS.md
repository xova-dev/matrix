# Matrix

Use `mise exec -- pnpm …`. Tool versions: `mise.toml` and `package.json`.
Details: [tests and profiles](test/README.md), [contributing](docs/site/en/contributing.md).

## Change Workflow

1. Read affected contracts and tests; add behavioral regressions. Reuse `test/helpers/runtime-fixtures.ts` for transforms.
2. Run checks below. Test packed packages in isolated consumers.
3. Sync affected English/Chinese docs and examples; update `test/README.md` for coverage changes. Exclude research notes and temporary logs.
4. Report completed checks and gaps; distinguish local tests, cross-platform CI, and real Electron acceptance.

## Checks

- Source: relevant Vitest tests, lint, typecheck. `pnpm check` excludes package and Electron acceptance.
- Exports, adapters, runtime, typegen: add `pnpm test:pack --profile daily`.
- Support ranges or version pins: run full `pnpm test:pack`.
- Electron development, packaging, startup: add `pnpm test:electron-web`; type preparation is insufficient.
- Docs: lint affected Markdown; site changes also need `pnpm docs:typecheck` and `pnpm docs:build`.

## Compatibility and Dependencies

- Preserve consumer-based host resolution, optional host peers, and host-free CLI installs; no fixed regular host dependencies.
- Supported ranges: `package.json`. Test pins/settings: `scripts/compatibility-matrix.json`. Broaden support only after consumer verification; sync both integration guides without weakening type checks.
- Root dependencies use `pnpm-workspace.yaml` catalogs. Update the lockfile and verify `pnpm install --frozen-lockfile` after dependency changes.
- Reduced profiles retain supported ranges. Full checks run before publication or manually; no scheduled runs by default.

## Releases and Maintenance

- Use changelogen for versions and root `CHANGELOG.md`; docs reference that file.
- Before publication: `pnpm check` and full `pnpm test:pack`. See [publish workflow](.github/workflows/publish.yml).
- `release:prepare` pushes; `release:github` creates a release and triggers publishing. Require explicit authorization for those actions; implementation or commit requests are insufficient.
- Keep this file for lasting conventions; maintain version lists, matrix counts, and run results elsewhere.
