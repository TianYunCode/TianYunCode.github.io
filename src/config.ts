export const SITE = {
  title: '拾光集',
  tagline: 'C/C++、Qt、嵌入式与工程实践',
  description:
    '按章节地图推进的技术笔记：C 语言、C++、数据结构、并发、Qt 6、Windows/Win32、Linux、操作系统、网络、嵌入式、数据库、构建与调试。基于 Astro 构建，部署在 GitHub Pages。',
  author: 'wty',
  // 首页每页文章数
  postsPerPage: 8,
  nav: [
    { href: '/', label: '首页' },
    { href: '/categories/', label: '专栏' },
    { href: '/tags/', label: '标签' },
    { href: '/archive/', label: '归档' },
    { href: '/about/', label: '关于' },
  ],
};

export const GISCUS = {
  // 留空则文章页不加载评论。填写步骤见 README.md
  repo: '',
  repoId: '',
  category: 'Announcements',
  categoryId: '',
};
