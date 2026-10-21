# Development and verification

See the [examples guide](https://github.com/xova-dev/matrix/blob/main/examples/README.md) for workspace setup and verification boundaries. `examples/basic` is the framework-free introduction; the [dual-Web/shared-Electron example](https://github.com/xova-dev/matrix/blob/main/examples/electron-web/README.md) exercises preparation, development dependencies, packaging and real application startup. After `pnpm install --frozen-lockfile` and `pnpm build`, run `pnpm example:basic` for the interactive introduction or `pnpm example:electron-web` to prepare the Electron workspace. `pnpm check:examples` checks both Matrix configurations. `pnpm test:electron-web` separately verifies the current tarball in a temporary, lockfile-pinned consumer outside the workspace.

CI verifies changes; Publish verifies the complete final tagged candidate through pinned Xova Actions workflows. See the [test guide](https://github.com/xova-dev/matrix/blob/main/test/README.md#ci-environments) for the matrix, release checks and local integration fixtures.

Development dependencies use the pnpm catalog in `pnpm-workspace.yaml`. Published-package consumer versions and typecheck settings live in `scripts/compatibility-matrix.json`.

```bash
pnpm install
pnpm check
pnpm lint:fix
```

`pnpm lint:fix` formats JavaScript, TypeScript, and Markdown through ESLint. `pnpm check` runs lint, typecheck, tests, and the production build without starting example services.

`pnpm test:pack` verifies an installed tarball in isolated consumers. It defaults to the full profile; use `--profile daily` or `--profile platform` for smaller local runs. Manually dispatch CI with `full` enabled for full cross-platform verification. Supported ranges are declared in `package.json`; the [test guide](https://github.com/xova-dev/matrix/blob/main/test/README.md) defines coverage and profiles.

## Release preparation and delivery

Native release-it inherits the preparation preset pinned in .release-it.json. Use an explicit intended version; 0.4.0 below is an example. The preset disables Git delivery, npm publication and GitHub/GitLab Releases:

```bash
mise exec -- pnpm exec release-it 0.4.0 --ci --dry-run
mise exec -- pnpm exec release-it 0.4.0 --ci
```

Preparation requires a clean worktree and updates the package version and root `CHANGELOG.md`. Preview success does not run project checks. Inspect the diff and index: the official plugin may stage a newly created changelog. Retain partial work on failure. Review notes and add necessary migration docs, examples or code; candidate commits are not restricted to version/changelog files, and titles do not skip checks. Commit, tag, push and GitHub Release creation remain separately authorized. Creating a GitHub Release triggers publication.
CI and publication share product-owned `checks.yml`. Commands and documentation settings are declared once in `.github/xova.json`. Its quality job calls shared `check.yml`; compatibility/Electron jobs remain product-owned and start after successful quality checks. Ordinary CI may use the shared docs-only decision; Publish keeps full checks on its exact source SHA. Publish then calls shared `release.yml`. Generic setup, configuration validation, source/recovery guards and upstream behavior tests live in Xova Actions. Shared workflows read .github/xova.json by default; commands/setup have no workflow-input override. Documentation checks, release builds and recovery all use the same check(kind=docs) path. Custom jobs can compose operation actions directly.

Publication selects pnpm packing. After complete product checks on the same SHA, the publisher runs `pnpm build` rather than repeating lint/types/examples, then runs `pnpm test:pack --profile daily` against the supplied absolute `TARBALL`. It consumes that file without repacking; source and tarball bytes are rechecked before publication. Without `TARBALL`, local `test:pack` still packs once. Release tooling uses Node 24; Node 22.18.0 product compatibility remains separate.

`docs-recover.yml` is a thin manual entry that passes the confirmed release tag/SHA to shared recovery. Publication and recovery select the same `github-pages` environment and concurrency group and `latest-stable` policy. Only stable release events deploy through Publish; manual publication does not. Recovery rebuilds the confirmed source and does not republish npm.

The npm Trusted Publisher continues to identify `xova-dev/matrix`, entrypoint `publish.yml` and environment `npm-publish`. Environment and Pages policies remain administrator settings. Consumer tests cover product matrices and wiring; the shared repository owns generic publication and recovery regressions.

The four shared workflow references pin the same full toolkit SHA after its remote CI passed. Normal `mise exec -- pnpm check` needs no local toolkit binding; optionally use `XOVA_ACTIONS_ROOT=../actions mise exec -- pnpm check` with that toolkit revision to validate its actual workflow contracts and configuration parser. The binding rejects a different HEAD or modified tracked files/index before reading contracts. The preparation preset stays independently pinned. Toolkit CI does not establish nested required-check names, Matrix-hosted execution, OIDC or real deployment acceptance.

## Documentation site

VitePress runs in the private `docs` workspace, with its own host dependencies. It does not change the Matrix package exports or add documentation to the npm package. The root `build` and `prepack` remain library-only.

From the repository root, after installing workspace dependencies:

```bash
pnpm docs:typecheck
pnpm docs:build
pnpm docs:preview
```

Run `pnpm docs:dev` for live editing; stop the server with `Ctrl+C` before running other commands. After rebuilding, restart a running preview to refresh its cached file metadata. The site uses `/matrix/` as its base path for GitHub project Pages, including local preview. Follow the URL printed by VitePress.

Site content lives under `docs/site/en/` and `docs/site/zh-CN/`, with matching page paths. The single `.vitepress/config.ts` uses `srcDir: 'site'` and rewrites English routes to the site root; there is no extra `site/index.md` or language-selection page. Default URLs are `/matrix/` and `/matrix/zh-CN/`. Guides explain workflows; references own fields and contracts. `getting-started.md` includes the `installation` and `quick-start` regions from the root READMEs; preserve those markers. Package metadata and this workspace README stay outside the site source. Links to examples and test instructions outside the site source point to GitHub.

The default VitePress theme keeps the URL fragment when switching languages. Corresponding pages are selected, but localized heading IDs differ, so switching from a section anchor does not guarantee positioning at the same section. This site retains that default behavior without a custom compatibility layer.

The site maintains one published version, without a version selector, historical snapshots, or a Next site. Its default-theme navigation reads the version from the root `package.json` and links to that GitHub Release. Both changelog pages include the root `CHANGELOG.md`; maintain release notes there rather than copying them into site pages.

Built consumer pages and the Examples navigation link to the package version tag, so their README and example instructions cannot drift with unreleased `main` changes. Source Markdown can keep `main` links for repository browsing; the renderer pins them at build time. Contributor links on this page remain on `main`. Check and release runs have separate concurrency groups, so manually checking the same tag cannot cancel its release deployment.

The documentation workflow checks types and builds on relevant PRs, main pushes, and manual runs without deploying. Publish builds the release-tag site before npm publication and reuses that artifact for deployment afterward. Only the latest stable GitHub Release deploys to Pages; failed publication, prereleases, and manual publication do not update the site.

If npm succeeds but documentation deployment fails, confirm the published version and exact source SHA using native npm logs, registry state and provenance; reporting/upload failure may make even the npm job fail after publication. The shared publication JSON/summary can assist but is not independent registry proof. Run **Recover documentation** (`docs-recover.yml`) with the confirmed `release-tag` and `published-sha`, without republishing npm. Both paths read the same `.github/xova.json`, share a lock and check the latest stable Release after entering `github-pages`; wrong sources fail and stale versions skip. Artifact repository, SHA and content digest include hidden site files.

Select the same release tag as the recovery run ref; `github-pages` currently permits `v*` tags. Recovery rejects a native ref/SHA mismatch before building. The selected tag must contain `docs-recover.yml` and `.github/xova.json`. Shared configuration paths must be nonempty; missing files fail before installation or product commands.

To enable the first deployment, an administrator must select **GitHub Actions** under the repository's **Settings → Pages → Build and deployment** and allow the `github-pages` environment to deploy from release tags such as `v*`, rather than only `main`. The workflow does not automatically enable Pages or change environment protection rules.

No live documentation URL is assumed in the package metadata or root README. Switch the primary entrypoint only after the first remote deployment succeeds. Change the VitePress `base` when deploying under a different repository name or a custom domain.
