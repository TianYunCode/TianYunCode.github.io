# 拾光集 · Astro + GitHub Pages 个人博客

纯静态博客，Markdown 写作，推送到 `main` 分支后由 GitHub Actions 自动构建发布。

## 本地开发

```bash
npm ci          # 首次安装依赖
npm run dev     # http://localhost:4321 热更新
npm run build   # 构建到 dist/
npm run preview # 本地预览构建产物
```

## 写文章

先在 `src/data/categories.ts` 里找到文章属于哪个大类的哪一节（14 个大类、156 个章节，每节有稳定 id），然后在 `src/content/posts/` 新建 `.md`：

```markdown
---
title: 文章标题
description: 摘要，出现在列表页、RSS 和分享卡片里
date: 2026-10-15
tags: [Astro, 建站]
category: cpp            # 大类 slug，可省略（不属于任何专栏时）
section: cpp-template    # 章节 id，必须属于上面那个 category
updated: 2026-10-16      # 可选
draft: false             # 可选，true 则不发布
comment: true            # 可选，false 关闭本页评论
---
```

- 文件名即 URL：`my-first-post.md` → `/posts/my-first-post/`。放到子目录里也能正常工作（路由用的是 `[...slug]`）。
- 想临时藏一篇：文件名加下划线前缀 `_wip.md`，或写 `draft: true`。
- `category` / `section` 写错（拼错、章节归错大类、只写 section 不写 category）**构建时直接报错并指出是哪篇**，不会留下挂不进地图的文章。
- 字段名写错同样在 `npm run build` 阶段报错（schema 在 `src/content.config.ts`）。

## 专栏体系

- `/categories/` 是 14 个大类的总览，卡片上显示"已写 X / 共 Y 节"的进度。
- `/categories/<slug>/` 是单个专栏：按 基础 → 进阶 → 高级 铺开全部章节，**已写的章节列出文章，没写的显示"敬请期待"并列出该节计划覆盖的知识点**。
- 首页顶部有一排专栏入口（同样带进度），下面是最新文章。
- 改章节地图只动 `src/data/categories.ts` 一个文件：加章节、调顺序、改知识点都会立刻反映到专栏页和校验逻辑里。

## 部署（已配好）

线上地址：<https://tianyuncode.github.io/>　仓库：`TianYunCode/TianYunCode.github.io`（根站仓库，所以 URL 没有路径前缀）。
Pages 的 Source 已设为 **GitHub Actions**，流水线是 `.github/workflows/deploy.yml`。

日常只需要：

```bash
git add .
git commit -m "post: 新文章标题"
git push
```

推送后约 40 秒上线。想看构建状态：仓库 **Actions** 标签页里的 *Deploy to GitHub Pages*。
如果 Actions 报 `Pages not enabled` 之类的错，去 **Settings → Pages → Build and deployment → Source** 确认选的是 **GitHub Actions**（不是 Deploy from a branch）。

## 自定义域名（以后要加的时候）

1. 改 `astro.config.mjs` 里的 `site`（**只改这一行**，RSS / sitemap / OG 链接全部由它派生）。
2. 新建 `public/CNAME`，内容只有一行域名，不带 `https://` 和斜杠，例如：`blog.tianyuncode.com`。
3. 在 DNS 服务商加记录：
   - 子域名（推荐，`blog.xxx.com`）：`CNAME` → `tianyuncode.github.io.`
   - 裸域名（`xxx.com`）：四条 `A` 记录 → `185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`
4. 仓库 **Settings → Pages** 勾选 **Enforce HTTPS**（证书由 GitHub 签发，DNS 生效后可能要等几分钟到几小时，第一次显示 pending 是正常的）。
5. 重新 `git push` 一次让 CNAME 生效。旧地址 `tianyuncode.github.io` 仍然可访问，不影响已分享的链接。

## 开启评论（Giscus）

1. 仓库 **Settings → Features** 勾选 **Discussions**。
2. 打开 <https://giscus.app/zh-CN>，填仓库名，按页面提示调整 discussion 分类（默认 `Announcements`），拿到 `repo_id` 和 `category_id`。
3. 填进 `src/config.ts` 的 `GISCUS`。留空时文章页不会加载评论组件。
4. 评论主题会跟随站点的深浅色切换，无需额外配置。

## 改品牌与配色

- 站点名、副标题、作者、导航、每页文章数：`src/config.ts`
- 颜色、字体、圆角、正文宽度：`src/styles/global.css` 顶部的 CSS 变量（明暗两套分别定义）
- 分享卡片图 `public/og.png`：改完 `design/make-og.sh` 里的文字后执行 `bash design/make-og.sh` 重新生成
- 图标：`public/favicon.svg`

## 目录结构

```
src/
  config.ts               站点常量与 Giscus 配置
  data/categories.ts      14 个大类 × 章节地图（slug、标题、知识点、基础/进阶/高级）
  content.config.ts       文章 frontmatter schema + 大类/章节归属校验
  content/posts/          Markdown 文章
  layouts/                BaseLayout（head/页眉页脚）、PostLayout（目录、相邻文章、评论）
  pages/                  路由：首页、分页、文章、专栏、标签、归档、关于、404、rss.xml、robots.txt
  components/             页眉、主题切换、文章卡片、分页、Giscus
  styles/global.css       全部样式（无第三方 UI 库）
.github/workflows/deploy.yml  Pages 部署流水线
```
