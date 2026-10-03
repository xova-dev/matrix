import type { DefaultTheme } from 'vitepress'
import { defineConfig } from 'vitepress'
import { version } from '../../package.json'

export default defineConfig({
  title: 'Matrix',
  description: 'Configuration-driven CLI for multi-app workspaces.',
  base: '/matrix/',
  srcDir: 'site',
  rewrites: { 'en/:rest*': ':rest*' },
  markdown: {
    config(md) {
      const link = md.renderer.rules.link_open!
      md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
        const token = tokens[index]
        const href = token.attrGet('href')
        // Keep repository browsing on main, but pin built consumer docs to this release.
        if (href && !env.relativePath?.endsWith('contributing.md')) {
          token.attrSet('href', href.replace(/^(https:\/\/github\.com\/xova-dev\/matrix\/(?:blob|tree)\/)main\//, `$1v${version}/`))
        }
        return link(tokens, index, options, env, renderer)
      }
    },
  },
  locales: {
    'root': {
      label: 'English',
      lang: 'en',
      link: '/',
      description: 'Configuration-driven CLI for multi-app workspaces.',
      themeConfig: {
        nav: nav('en'),
        sidebar: sidebar('en'),
        outline: { level: [2, 3], label: 'On this page' },
      },
    },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh-CN/',
      description: '面向多应用工作区的配置驱动 CLI。',
      themeConfig: {
        nav: nav('zh-CN'),
        sidebar: sidebar('zh-CN'),
        outline: { level: [2, 3], label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        langMenuLabel: '切换语言',
        sidebarMenuLabel: '目录',
        returnToTopLabel: '返回顶部',
        darkModeSwitchLabel: '外观',
      },
    },
  },
  themeConfig: {
    socialLinks: [{ icon: 'github', link: 'https://github.com/xova-dev/matrix' }],
    search: {
      provider: 'local',
      options: {
        locales: {
          'zh-CN': {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '重置搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到相关内容',
                footer: {
                  selectText: '选择',
                  selectKeyAriaLabel: '回车',
                  navigateText: '切换',
                  navigateUpKeyAriaLabel: '上箭头',
                  navigateDownKeyAriaLabel: '下箭头',
                  closeText: '关闭',
                  closeKeyAriaLabel: 'Esc',
                },
              },
            },
          },
        },
      },
    },
  },
})

function nav(locale: 'en' | 'zh-CN'): DefaultTheme.NavItem[] {
  const prefix = locale === 'en' ? '' : '/zh-CN'
  const zh = locale === 'zh-CN'
  return [
    { text: zh ? '开始使用' : 'Get started', link: `${prefix}/getting-started` },
    { text: zh ? '参考' : 'Reference', link: `${prefix}/reference/configuration` },
    { text: zh ? '示例' : 'Examples', link: `https://github.com/xova-dev/matrix/tree/v${version}/examples` },
    { text: zh ? '更新日志' : 'Changelog', link: `${prefix}/changelog` },
    {
      text: `v${version}`,
      items: [
        { text: zh ? `v${version} 更新日志` : `v${version} changelog`, link: `${prefix}/changelog#v${version.replaceAll('.', '-')}` },
        { text: 'GitHub Release', link: `https://github.com/xova-dev/matrix/releases/tag/v${version}` },
      ],
    },
  ]
}

function sidebar(locale: 'en' | 'zh-CN'): DefaultTheme.SidebarItem[] {
  const prefix = locale === 'en' ? '' : '/zh-CN'
  const zh = locale === 'zh-CN'
  const link = (page: string): string => `${prefix}/${page}`
  return [
    {
      text: zh ? '开始使用' : 'Start',
      items: [
        { text: zh ? '概览' : 'Overview', link: link('') },
        { text: zh ? '快速开始' : 'Getting started', link: link('getting-started') },
        { text: zh ? '核心概念' : 'Core concepts', link: link('concepts') },
      ],
    },
    {
      text: zh ? '指南' : 'Guides',
      items: [
        { text: zh ? '环境与 schema' : 'Environments and schemas', link: link('guides/environments') },
        { text: zh ? '构建工具接入' : 'Build tool integration', link: link('guides/integrations') },
        { text: zh ? '执行与产物' : 'Execution and artifacts', link: link('guides/execution') },
        { text: zh ? '排错指南' : 'Troubleshooting', link: link('guides/troubleshooting') },
      ],
    },
    {
      text: zh ? '参考' : 'Reference',
      items: [
        { text: zh ? '配置' : 'Configuration', link: link('reference/configuration') },
        { text: 'CLI', link: link('reference/cli') },
        { text: zh ? '插件与 runtime' : 'Plugins and runtime', link: link('reference/plugins') },
      ],
    },
    {
      text: zh ? '贡献者' : 'Contributing',
      items: [{ text: zh ? '开发与验证' : 'Development and verification', link: link('contributing') }],
    },
  ]
}
