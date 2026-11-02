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
- When changes affect Electron development, packaging or startup, run the on-demand `pnpm test:electron-web`; type preparation is insufficient. Real Electron app acceptance is not a default CI or publication gate.
- Docs: lint affected Markdown; site changes also need `pnpm docs:typecheck` and `pnpm docs:build`.

## Compatibility and Dependencies

- Preserve consumer-based host resolution, optional host peers, and host-free CLI installs; no fixed regular host dependencies.
- Supported ranges: `package.json`. Test pins/settings: `scripts/compatibility-matrix.json`. Broaden support only after consumer verification; sync both integration guides without weakening type checks.
- Root dependencies use `pnpm-workspace.yaml` catalogs. Update the lockfile and verify `pnpm install --frozen-lockfile` after dependency changes.
- Reduced profiles retain supported ranges. Ubuntu / Node 24 owns full host checks; Ubuntu / Node 22 checks the runtime floor and Windows / Node 24 checks platform contracts. macOS and real Electron app acceptance are on demand; no scheduled runs by default.

## Releases and Maintenance

- Use native release-it with the pinned shared preparation preset for versions and root `CHANGELOG.md`; docs reference that file.
- Verify the final tagged candidate, including release notes, migration docs and necessary code. Publish requires the Linux host/runtime-floor and Windows platform checks on that exact SHA through qualified CI or complete fallback, then exact-tarball/package/docs checks; parent CI and commit titles never exempt a candidate. On-demand Electron/macOS acceptance does not replace these gates. See [publish workflow](.github/workflows/publish.yml).
- Run `pnpm exec release-it <version> --ci --dry-run` to preview and omit `--dry-run` to prepare locally. The preset disables committing, tagging, pushing and publication; the official changelog plugin may stage a new changelog. Git delivery and GitHub Release creation require explicit authorization.
- Package verification consumes `TARBALL` when supplied and otherwise packs once for local compatibility tests. Publication explicitly builds first, uses pnpm pack without lifecycle scripts and verifies that same tarball before publishing.
- Declare commands/setup/docs settings once in `.github/xova.json`. `checks.yml` retains product matrices and calls shared `check.yml` for quality; CI/Publish reuse it. Xova Actions owns generic setup/config/source/recovery behavior. Keep only product wiring tests here.
- Before delivery, pin all shared workflow calls to one full toolkit SHA with successful remote CI; never point new contracts at an older SHA. Optional `XOVA_ACTIONS_ROOT` verification must use that clean toolkit revision to check local workflow contracts and configuration; reject a different HEAD or tracked/index changes before reading it. Toolkit CI does not prove consumer-hosted execution or nested required-status names. Restore documentation through the thin recovery entry after confirming the published source.
- Keep this file for lasting conventions; maintain version lists, matrix counts, and run results elsewhere.
