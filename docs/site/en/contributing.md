# Development and verification

See the [examples guide](https://github.com/xova-dev/matrix/blob/main/examples/README.md) for workspace setup and verification boundaries. `examples/basic` is the framework-free introduction; the [dual-Web/shared-Electron example](https://github.com/xova-dev/matrix/blob/main/examples/electron-web/README.md) exercises preparation, development dependencies, packaging and real application startup. After `pnpm install --frozen-lockfile` and `pnpm build`, run `pnpm example:basic` for the interactive introduction or `pnpm example:electron-web` to prepare the Electron workspace. `pnpm check:examples` checks both Matrix configurations. `pnpm test:electron-web` separately verifies the current tarball in a temporary, lockfile-pinned consumer outside the workspace.

CI runs on pull requests, main pushes, and manual dispatch. The [test matrix](https://github.com/xova-dev/matrix/blob/main/test/README.md#compatibility-matrix) defines OS / Node jobs, packaged hosts, Electron acceptance, and platform-specific skips.

Development dependencies use the pnpm catalog in `pnpm-workspace.yaml`. Published-package consumer versions and typecheck settings live in `scripts/compatibility-matrix.json`.

```bash
pnpm install
pnpm check
pnpm lint:fix
```

`pnpm lint:fix` formats JavaScript, TypeScript, and Markdown through ESLint. `pnpm check` runs lint, typecheck, tests, and the production build without starting example services.

`pnpm test:pack` installs the same tarball into a host-free CLI consumer and mixed-version host workspaces, then runs the checks in the test matrix. Daily CI selects boundary profiles from one exact-version manifest; `package.json` peer dependencies declare supported ranges. The release workflow runs `pnpm check` and the full `pnpm test:pack` profile. Use `--profile daily` or `--profile platform` for smaller local runs; manually dispatch CI with `full` enabled for the complete cross-platform matrix. Electron acceptance runs in independent jobs. Package logs include phase durations and the slowest consumers.

See the [test guide](https://github.com/xova-dev/matrix/blob/main/test/README.md) for test organization and coverage boundaries.

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

The documentation workflow checks types and builds on relevant pull requests, `main` pushes, and manual runs; these never deploy. After npm publication succeeds for a non-prerelease GitHub Release, the release workflow calls the same documentation workflow to check out the release tag, verify that it matches `package.json`, and build the site. Deployment checks that this is still the latest stable GitHub Release, so rerunning an older release cannot replace the current documentation. Failed npm publication, prereleases, and manual package publication do not update Pages. The first deployable release must contain the documentation workspace and workflows; existing tags without them are not backfilled.

To enable the first deployment, an administrator must select **GitHub Actions** under the repository's **Settings → Pages → Build and deployment** and allow the `github-pages` environment to deploy from release tags such as `v*`, rather than only `main`. The workflow does not automatically enable Pages or change environment protection rules.

No live documentation URL is assumed in the package metadata or root README. Switch the primary entrypoint only after the first remote deployment succeeds. Change the VitePress `base` when deploying under a different repository name or a custom domain.
