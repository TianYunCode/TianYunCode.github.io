import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// site 决定 RSS / sitemap / OG 分享链接里的绝对域名，换域名只改这一行
export default defineConfig({
  site: 'https://wty.blogs.abrdns.com',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      langs: ['js', 'ts', 'jsx', 'tsx', 'json', 'bash', 'sh', 'html', 'css', 'md', 'yaml', 'toml', 'diff', 'text'],
    },
  },
  vite: {
    resolve: {
      // 避免 .astro 生成的类型在构建期解析失败
      tsconfck: { base: '.', },
    },
  },
});
