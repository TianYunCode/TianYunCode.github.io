---
title: Astro 内容集合的正确用法
description: 用 glob loader 加 zod schema 把 Markdown 变成有类型约束的数据源，写错字段构建期就报错。
date: 2026-10-08
tags: [Astro, 前端, 建站]
updated: 2026-10-12
---

Astro 5 把内容层（Content Layer）拆出来之后，内容集合的写法换了一套。旧的 `slug` 字段和 `entry.slug` 已经不用了，网上很多教程还停留在 4.x，这里记一下现在能跑通的最小配置。

## 1. 定义集合

文件放在 `src/content.config.ts`，注意是 `src` 根下，不是 `src/content/` 里面。

```ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
```

两个细节：

- `pattern: '**/[^_]*.md'` 让下划线开头的文件被忽略，草稿可以直接命名为 `_wip.md` 而不需要额外的 `draft: true`。
- `z.coerce.date()` 会把 `2026-10-08` 解析成 `Date`，但按 UTC 零点处理。如果你在 UTC-5 用 `getFullYear()` 取年份，会少一天——所以我统一用 UTC getter。

## 2. 读取

```ts
import { getCollection } from 'astro:content';

const posts = (await getCollection('posts', ({ data }) => !data.draft))
  .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
```

`getCollection` 的第二个参数是过滤函数，比先全取出来再 filter 省一次遍历。返回的 `entry.body` 是 Markdown 原文，做「阅读时长」统计直接用它，不需要渲染后的 HTML。

## 3. 渲染文章页

`src/pages/posts/[...slug].astro` 里用 `[...slug]` 而不是 `[slug]`，这样文章可以放到子目录（比如 `posts/2026/xxx.md`）而不会 404。

```astro
---
import { render } from 'astro:content';
const { Content } = await render(post);
---
<PostLayout post={post}>
  <Content />
</PostLayout>
```

`render()` 返回的 `Content` 是一个组件；旧的 `render(entry).html` 字符串写法已经没了。顺带一提，代码高亮用的是内置 Shiki，构建期完成，浏览器上不加载任何高亮脚本。

## 4. 深浅色两套高亮

```js
// astro.config.mjs
markdown: {
  shikiConfig: {
    themes: { light: 'github-light', dark: 'github-dark-dimmed' },
  },
},
```

配置两套主题后，Astro 在 `<pre>` 上同时挂出亮色的行内 `color` 和暗色的 `--shiki-dark` 变量，所以亮色什么都不用写，只需要在暗色下覆盖：

```css
.astro-code {
  background: var(--code-bg) !important;
}
:root[data-theme='dark'] .astro-code,
:root[data-theme='dark'] .astro-code span[style] {
  color: var(--shiki-dark, inherit) !important;
}
```

这样切换主题不需要重新渲染，纯 CSS 变量换色，不会闪一下。另外 `<pre>` 上有 `data-language="ts"`，做语言角标直接读这个属性，别去找 `language-*` class——Astro 并不加。

## 常见的坑

1. `content.config.ts` 文件名写成 `content-collection.ts`，集合不会被加载，页面里 `getCollection` 直接抛错。
2. frontmatter 里日期写成 `2026/10/08`，`z.coerce.date()` 在部分环境下解析失败，统一用 ISO 的短横线格式最稳。
3. 用 `entry.id` 拼 URL 时忘了它不带扩展名，`hello.md` 对应的 `id` 就是 `hello`。
