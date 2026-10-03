# Documentation workspace

This private workspace builds the Matrix documentation with VitePress. It is not published to npm.

- [English documentation](site/en/index.md)
- [简体中文文档](site/zh-CN/index.md)
- [Site development and deployment](site/en/contributing.md#documentation-site) · [站点开发与部署](site/zh-CN/contributing.md#文档站点)

Keep the site configuration in `.vitepress/config.ts`. Public content lives in `site/en/` and `site/zh-CN/`, with corresponding paths. `en/` routes are rewritten to the site root, so the default home comes from `site/en/index.md`; do not add a third `site/index.md` or a language-selection page. Package metadata and this README stay outside the site source.

Use `concepts.md` for the model, `guides/` for workflows, and `reference/` for fields and contracts. The getting-started pages include named regions from the root READMEs rather than maintaining a second configuration example. Maintain runnable example instructions in their own READMEs, not another copy here. Documentation explains repository behavior; it does not replace consumer, interactive-terminal, or cross-platform acceptance.

Links within site Markdown follow the rewritten routes. In the English tree, relative links between English pages still work because all those pages share the same removed `en/` prefix. Root READMEs and this workspace README link to the actual source files for repository browsing. Do not add per-page language links; the theme handles corresponding locale routes.

The site has one published version, without historical snapshots or a Next site. The default-theme navigation reads the version from the root `package.json`; both changelog pages include the root `CHANGELOG.md`. Pull requests, main pushes, and manual documentation runs only check and build. The release workflow calls the same documentation workflow after npm publication succeeds, builds the release tag, and deploys only the latest stable GitHub Release. Configure the Pages environment to permit release tags such as `v*`, rather than only `main`.

Check and release runs use separate concurrency groups, so manually checking a release tag cannot cancel its deployment. Markdown source links stay readable on GitHub: the build rewrites repository `blob/main/` and `tree/main/` links to the package version tag, except in `contributing.md`, whose contributor links remain on `main`. The Examples navigation always links to the version tag. Preserve this policy when adding pages; no per-release URL edits are needed.
