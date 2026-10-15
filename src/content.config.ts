import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORY_MAP, SECTION_INDEX } from './data/categories';

const posts = defineCollection({
  loader: glob({
    pattern: '**/[^_]*.{md,mdx}',
    base: './src/content/posts',
    transform: ({ entry, data }) => {
      const { category, section } = data as { category?: string; section?: string };
      if (category && !CATEGORY_MAP.has(category)) {
        throw new Error(`「${entry.id}」的 category "${category}" 不在 src/data/categories.ts 的大类清单里`);
      }
      if (section) {
        const hit = SECTION_INDEX.get(section);
        if (!hit) {
          throw new Error(`「${entry.id}」的 section "${section}" 不存在，见 src/data/categories.ts`);
        }
        if (!category) {
          throw new Error(`「${entry.id}」写了 section "${section}" 但没写 category`);
        }
        if (hit.category.slug !== category) {
          throw new Error(`「${entry.id}」的 section "${section}" 属于大类 "${hit.category.slug}"，不是 "${category}"`);
        }
      }
      return data;
    },
  }),
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
