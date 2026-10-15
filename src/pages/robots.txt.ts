import type { APIContext } from 'astro';

export function GET(context: APIContext) {
  const site = context.site as URL;
  return new Response(
    [`User-agent: *`, 'Allow: /', '', `Sitemap: ${new URL('/sitemap-index.xml', site).href}`].join('\n'),
    { headers: { 'content-type': 'text/plain; charset=utf-8' } }
  );
}
