import { getCollection } from 'astro:content';

export type Post = Awaited<ReturnType<typeof getPosts>>[number];

export async function getPosts() {
  const posts = await getCollection('posts', ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
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

export function slugifyTag(tag: string) {
  return encodeURIComponent(tag.toLowerCase());
}
