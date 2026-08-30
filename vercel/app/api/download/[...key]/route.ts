import { head } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 简单下载接口（非 S3 协议）。
 *
 *   GET /api/download/{...key}          → 302 重定向到 Blob 公开 URL
 *   GET /api/download/{...key}?proxy=1  → 流式代理返回文件内容（支持 Range）
 *
 * 公开文件无需认证（Vercel Blob access=public）；
 * 若需要鉴权可在此处加 token 校验。
 */

const PUBLIC_CACHE = "public, max-age=31536000, immutable";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ key: string[] }> }
) {
  const { key } = await ctx.params;
  const blobKey = key.join("/");

  if (!blobKey) {
    return new Response("Not Found", { status: 404 });
  }

  const info = await head(blobKey);
  if (!info) {
    return new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const proxy = url.searchParams.get("proxy") === "1";

  // 直接重定向模式：浏览器自动跳转到 Blob CDN
  if (!proxy) {
    return Response.redirect(info.url, 302);
  }

  // 流式代理模式：支持 Range 请求，适合需要隐藏源 URL 的场景
  const range = request.headers.get("range");
  const upstream = await fetch(info.url, {
    headers: range ? { Range: range } : {},
  });

  const headers = new Headers();
  for (const h of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(h);
    if (value) headers.set(h, value);
  }
  headers.set("cache-control", PUBLIC_CACHE);

  return new Response(upstream.body, { status: upstream.status, headers });
}
