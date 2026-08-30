import { put, del, head } from "@vercel/blob";
import { verifySignature } from "../../../lib/sigv4";

// 仅在 Node.js 运行时下 @vercel/blob 可用
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "";
const SECRET_KEY = process.env.S3_SECRET_KEY ?? "";

// 该网关使用 Vercel Blob 作为后端。这里约定：
//   /s3/{bucket}/{...key}
// bucket 仅作为逻辑前缀，实际对象保存在 {bucket}/{key} 这个可读路径下。
const PUBLIC_CACHE = "public, max-age=31536000, immutable";

function s3Error(code: string, message: string, status: number): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return new Response(xml, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

async function authenticate(request: Request): Promise<ReturnType<typeof verifySignature>> {
  if (!ACCESS_KEY || !SECRET_KEY) throw new Error("S3 密钥未配置");
  return verifySignature(request, {
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });
}

/** 从 /s3/{bucket}/{...key} 提取 bucket 与 key（key 去掉 bucket 段） */
function parseKey(segments: string[]): { bucket: string; key: string } {
  const [bucket = "", ...rest] = segments;
  return { bucket, key: rest.join("/") };
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ key: string[] }> }
) {
  const { bucket, key } = parseKey((await ctx.params).key);
  if (!key) return s3Error("InvalidArgument", "缺少对象 Key", 400);

  let v: Awaited<ReturnType<typeof verifySignature>>;
  try {
    v = await authenticate(request);
  } catch (e) {
    return s3Error("SignatureDoesNotMatch", (e as Error).message, 403);
  }

  const contentType =
    request.headers.get("content-type") ?? "application/octet-stream";

  // 拷贝成独立 Uint8Array（底层为 ArrayBuffer），兼容 BlobPart 类型
  const bytes = new Uint8Array(v.body.byteLength);
  v.body.copy(bytes);

  const blob = await put(`${bucket}/${key}`, new Blob([bytes], { type: contentType }), {
    access: "public",
    addRandomSuffix: false,
  });

  return new Response(null, {
    status: 200,
    headers: {
      ETag: `"${v.payloadHash === "UNSIGNED-PAYLOAD" ? bytes.byteLength.toString(16) : v.payloadHash}"`,
    },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ key: string[] }> }
) {
  const { bucket, key } = parseKey((await ctx.params).key);
  if (!key) return s3Error("NoSuchKey", "The specified key does not exist.", 404);

  try {
    await authenticate(request);
  } catch (e) {
    return s3Error("SignatureDoesNotMatch", (e as Error).message, 403);
  }

  const info = await head(`${bucket}/${key}`);
  if (!info) return s3Error("NoSuchKey", "The specified key does not exist.", 404);

  const range = request.headers.get("range");
  const upstream = await fetch(info.url, {
    headers: range ? { Range: range } : {},
  });

  const headers = new Headers();
  const passthrough = [
    "content-type",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];
  for (const h of passthrough) {
    const value = upstream.headers.get(h);
    if (value) headers.set(h, value);
  }
  headers.set("cache-control", PUBLIC_CACHE);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function HEAD(
  _request: Request,
  ctx: { params: Promise<{ key: string[] }> }
) {
  const { bucket, key } = parseKey((await ctx.params).key);
  if (!key) return s3Error("NoSuchKey", "The specified key does not exist.", 404);

  try {
    await authenticate(_request);
  } catch (e) {
    return s3Error("SignatureDoesNotMatch", (e as Error).message, 403);
  }

  const info = await head(`${bucket}/${key}`);
  if (!info) return s3Error("NoSuchKey", "The specified key does not exist.", 404);

  return new Response(null, {
    status: 200,
    headers: {
      "content-type": info.contentType,
      "content-length": String(info.size),
      "cache-control": PUBLIC_CACHE,
    },
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ key: string[] }> }
) {
  const { bucket, key } = parseKey((await ctx.params).key);
  if (!key) return s3Error("InvalidArgument", "缺少对象 Key", 400);

  try {
    await authenticate(request);
  } catch (e) {
    return s3Error("SignatureDoesNotMatch", (e as Error).message, 403);
  }

  const info = await head(`${bucket}/${key}`);
  if (info) await del(info.url);

  return new Response(null, { status: 204 });
}