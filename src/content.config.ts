import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 站点所有日期都按 UTC 展示（见 src/utils/post.ts 的 isoDate/formatDate）。
// 一旦作者写成带时间的形式（`2026-10-15T00:30`），本地时区换算后 UTC 已经是前一天，
// 列表页、RSS、sitemap 会一起错一天，而且不报任何错——所以在 schema 里就拒收。
const dateOnly = z
  .custom<Date>((v) => v instanceof Date || typeof v === 'string', {
    message: 'date 必须是 YYYY-MM-DD',
  })
  .transform((v, ctx) => {
    if (typeof v === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
      if (!m) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `date 只能写成 YYYY-MM-DD，收到 "${v}"。带时间或带时区的写法会让按 UTC 展示的日期漂一天`,
        });
        return z.NEVER;
      }
      return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    }
    if (v.getUTCHours() !== 0 || v.getUTCMinutes() !== 0 || v.getUTCSeconds() !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `date 带了时间部分（${v.toISOString()}），按 UTC 展示会漂一天，请只写 YYYY-MM-DD`,
      });
      return z.NEVER;
    }
    return v;
  });

// 章节地图的跨文件校验（category / section 是否合法）不在这里做：
// Astro 5.18 的 glob() 只接受 pattern / base / generateId / retainBody，
// 传进去的 transform 会被静默忽略。校验改在 src/utils/post.ts 的读取端执行，构建期必然触发。
const posts = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(''),
    date: dateOnly,
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    category: z.string().optional(),
    section: z.string().optional(),
    draft: z.boolean().default(false),
    comment: z.boolean().default(true),
  }),
});

export const collections = { posts };
