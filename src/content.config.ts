import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 章节地图的跨文件校验（category / section 是否合法）不在这里做：
// Astro 5.18 的 glob() 只接受 pattern / base / generateId / retainBody，
// 传进去的 transform 会被静默忽略。校验改在 src/utils/post.ts 的读取端执行，构建期必然触发。
const posts = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(''),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    category: z.string().optional(),
    section: z.string().optional(),
    draft: z.boolean().default(false),
    comment: z.boolean().default(true),
  }),
});

export const collections = { posts };
