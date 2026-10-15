export const SITE = {
  title: '拾光集',
  tagline: '一个人的技术笔记与生活记录',
  description:
    '记录后端、前端与工程实践中值得留下来的东西。基于 Astro 构建，部署在 GitHub Pages 上。',
  author: 'wty',
  // 首页每页文章数
  postsPerPage: 8,
  nav: [
    { href: '/', label: '首页' },
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
