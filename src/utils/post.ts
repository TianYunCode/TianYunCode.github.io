import { getCollection } from 'astro:content';
import { CATEGORY_MAP, SECTION_INDEX } from '../data/categories';

export type Post = Awaited<ReturnType<typeof getPosts>>[number];

// Astro 5.18 的 glob() 没有 transform 选项，校验只能放在读取端；这里抛错会让构建失败。
function assertIntegrity(posts: readonly { id: string; data: { category?: string; section?: string } }[]) {
  for (const p of posts) {
    const { category, section } = p.data;
    if (category && !CATEGORY_MAP.has(category)) {
      throw new Error(`「${p.id}」的 category "${category}" 不在 src/data/categories.ts 的大类清单里`);
    }
    if (!section) continue;
    const hit = SECTION_INDEX.get(section);
    if (!hit) throw new Error(`「${p.id}」的 section "${section}" 不存在，见 src/data/categories.ts`);
    if (!category) throw new Error(`「${p.id}」写了 section "${section}" 但没写 category`);
    if (hit.category.slug !== category) {
      throw new Error(
        `「${p.id}」的 section "${section}" 属于大类 "${hit.category.slug}"，不是 "${category}"`
      );
    }
  }
}

export async function getPosts() {
  const posts = await getCollection('posts', ({ data }) => !data.draft);
  assertIntegrity(posts);
  // 同一天发布的文章按文件名升序，保证系列文章的先后顺序稳定
  return posts.sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf() || a.id.localeCompare(b.id)
  );
}

export const postPath = (post: Post) => `/posts/${post.id}/`;

const utc = (d: Date) => ({
  y: d.getUTCFullYear(),
  m: d.getUTCMonth() + 1,
  day: d.getUTCDate(),
});

export function formatDate(date: Date) {
  const { y, m, day } = utc(date);
  return `${y}年${m}月${day}日`;
}

export function isoDate(date: Date) {
  const { y, m, day } = utc(date);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function readingMinutes(markdown: string) {
  const text = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const cjk = (text.match(/[㐀-䶿一-鿿぀-ヿ]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return Math.max(1, Math.round(cjk / 300 + words / 200));
}

export function groupByYear(posts: Post[]) {
  const groups = new Map<number, Post[]>();
  for (const post of posts) {
    const year = utc(post.data.date).y;
    const bucket = groups.get(year);
    if (bucket) bucket.push(post);
    else groups.set(year, [post]);
  }
  return [...groups.entries()];
}

export function tagCounts(posts: Post[]) {
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      const bucket = map.get(tag);
      if (bucket) bucket.push(post);
      else map.set(tag, [post]);
    }
  }
  return [...map.entries()]
    .map(([tag, list]) => ({ tag, posts: list }))
    .sort((a, b) => b.posts.length - a.posts.length || a.tag.localeCompare(b.tag, 'zh-CN'));
}

// Windows 的目录名不能包含 <>:"/\|?* 与控制字符，而 CI 跑在 Ubuntu 上却能建出这些目录，
// 所以标签名在落到文件系统之前必须压成跨平台安全的形态。
export function tagFolder(tag: string) {
  const illegal = new Set([0x3c, 0x3e, 0x3a, 0x22, 0x2f, 0x5c, 0x7c, 0x3f, 0x2a]);
  let out = '';
  for (const ch of tag) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || illegal.has(c) ? '-' : ch;
  }
  return out.replace(/^-+/, '').replace(/-+$/, '').replace(/-{2,}/g, '-') || 'tag';
}

export function tagHref(tag: string) {
  return `/tags/${encodeURIComponent(tagFolder(tag))}/`;
}

export function postsInCategory(posts: Post[], slug: string) {
  return posts.filter((post) => post.data.category === slug);
}

// 章节内的文章按时间正序排列，符合"先写的先读"的学习顺序
export function postsBySection(posts: Post[]) {
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    const section = post.data.section;
    if (!section) continue;
    const bucket = map.get(section);
    if (bucket) bucket.push(post);
    else map.set(section, [post]);
  }
  for (const list of map.values()) list.sort((a, b) => a.data.date.valueOf() - b.data.date.valueOf());
  return map;
}
