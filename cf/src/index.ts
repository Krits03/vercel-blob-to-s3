import { Hono } from "hono";
import { verifySignature } from "./sigv4";

/**
 * Cloudflare Worker 入口。
 *
 * 与 Vercel 版功能对齐，但后端调用 Vercel Blob 的 REST API
 * （Worker 环境无法使用 @vercel/blob SDK）。
 *
 * 路由：
 *   S3 兼容：/s3/{bucket}/{...key}     PUT / GET / HEAD / DELETE
 *   简单上传：/api/upload               POST  (raw body 或 multipart)
 *   简单下载：/api/download/{...key}    GET   (302 重定向 或 ?proxy=1)
 *   健康检查：/                        GET
 */

export type Env = {
  BLOB_READ_WRITE_TOKEN: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  UPLOAD_TOKEN: string;
  BLOB_BASE_URL?: string;
};

const app = new Hono<{ Bindings: Env }>();

const JSON_HEADERS = { "content-type": "application/json" };

// ---------------------------------------------------------------------------
// Vercel Blob REST API 封装
// ---------------------------------------------------------------------------

/** 上传对象到 Vercel Blob */
async function blobPut(
  token: string,
  pathname: string,
  body: BodyInit,
  contentType: string
): Promise<{ url: string; pathname: string }> {
  const res = await fetch(
    `https://blob.vercel-storage.com?pathname=${encodeURIComponent(pathname)}`,
    {
      method: "POST",
      body,
      headers: {
        authorization: `Bearer ${token}`,
        "x-content-type": contentType,
        "x-add-random-suffix": "false",
        "x-cache-control-max-age": "31536000",
      },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blob PUT 失败 (${res.status}): ${text}`);
  }
  return res.json();
}

/** 查询对象元信息（head） */
async function blobHead(
  token: string,
  pathname: string
): Promise<{ url: string; size: number; contentType: string } | null> {
  const res = await fetch(
    `https://blob.vercel-storage.com?pathname=${encodeURIComponent(pathname)}`,
    {
      method: "HEAD",
      headers: { authorization: `Bearer ${token}` },
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Blob HEAD 失败 (${res.status})`);
  }
  return {
    url: res.headers.get("x-blob-url") ?? "",
    size: Number(res.headers.get("x-blob-size") ?? 0),
    contentType: res.headers.get("x-blob-content-type") ?? "application/octet-stream",
  };
}

/** 删除对象 */
async function blobDel(token: string, url: string): Promise<void> {
  await fetch(`https://blob.vercel-storage.com?url=${encodeURIComponent(url)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function s3Error(code: string, message: string, status: number): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return new Response(xml, { status, headers: { "content-type": "application/xml" } });
}

function applyBaseUrl(url: string, env: Env): string {
  if (env.BLOB_BASE_URL) {
    try {
      const u = new URL(url);
      const base = new URL(env.BLOB_BASE_URL);
      u.hostname = base.hostname;
      u.protocol = base.protocol;
      return u.toString();
    } catch {
      /* ignore */
    }
  }
  return url;
}

function parseKey(segments: string[]): { bucket: string; key: string } {
  const [bucket = "", ...rest] = segments;
  return { bucket, key: rest.join("/") };
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

app.get("/", (c) =>
  c.json({ ok: true, service: "twikoo-blob-s3-cf", version: "1.0.0" })
);

// ---------------------------------------------------------------------------
// S3 兼容接口：/s3/{bucket}/{...key}
// ---------------------------------------------------------------------------

app.put("/s3/*", async (c) => {
  const env = c.env;
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    return s3Error("InternalError", "S3 密钥未配置", 500);
  }

  // 从 /s3/{bucket}/{...key} 提取 bucket 与 key
  const segments = c.req.path.replace(/^\/s3\//, "").split("/").filter(Boolean);
  const { bucket, key } = parseKey(segments);
  if (!key) return s3Error("InvalidArgument", "缺少对象 Key", 400);

  let v: Awaited<ReturnType<typeof verifySignature>>;
  try {
    v = await verifySignature(c.req.raw, {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    });
  } catch (e) {
    return s3Error("SignatureDoesNotMatch", (e as Error).message, 403);
  }

  const contentType =
    c.req.header("content-type") ?? "application/octet-stream";

  const blob = await blobPut(
    env.BLOB_READ_WRITE_TOKEN,
    `${bucket}/${key}`,
    v.body,
    contentType
  );

  const etag =
    v.payloadHash === "UNSIGNED-PAYLOAD"
      ? v.body.byteLength.toString(16)
      : v.payloadHash;

  return new Response(null, {
    status: 200,
    headers: { ETag: `"${etag}"` },
  });
});

app.get("/s3/*", async (c) => {
  const env = c.env;
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    return s3Error("InternalError", "S3 密钥未配置", 500);
  }

  const segments = c.req.path.replace(/^\/s3\//, "").split("/").filter(Boolean);
  const { bucket, key } = parseKey(segments);
  if (!key) return s3Error("NoSuchKey", "The specified key does not exist.", 404);

  try {
    await verifySignature(c.req.raw, {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    });
  } catch (e) {
    return s3Error("SignatureDoesNotMatch", (e as Error).message, 403);
  }

  const info = await blobHead(env.BLOB_READ_WRITE_TOKEN, `${bucket}/${key}`);
  if (!info) return s3Error("NoSuchKey", "The specified key does not exist.", 404);

  const range = c.req.header("range");
  const upstream = await fetch(info.url, {
    headers: range ? { Range: range } : {},
  });

  const headers = new Headers();
  for (const h of ["content-type", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(h);
    if (value) headers.set(h, value);
  }
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(upstream.body, { status: upstream.status, headers });
});

app.delete("/s3/*", async (c) => {
  const env = c.env;
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    return s3Error("InternalError", "S3 密钥未配置", 500);
  }

  const segments = c.req.path.replace(/^\/s3\//, "").split("/").filter(Boolean);
  const { bucket, key } = parseKey(segments);
  if (!key) return s3Error("InvalidArgument", "缺少对象 Key", 400);

  try {
    await verifySignature(c.req.raw, {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    });
  } catch (e) {
    return s3Error("SignatureDoesNotMatch", (e as Error).message, 403);
  }

  const info = await blobHead(env.BLOB_READ_WRITE_TOKEN, `${bucket}/${key}`);
  if (info) await blobDel(env.BLOB_READ_WRITE_TOKEN, info.url);

  return new Response(null, { status: 204 });
});

// ---------------------------------------------------------------------------
// 简单上传接口：POST /api/upload
// ---------------------------------------------------------------------------

app.post("/api/upload", async (c) => {
  const env = c.env;
  const token = env.UPLOAD_TOKEN ?? "";
  if (!token) {
    return c.json({ error: "UPLOAD_TOKEN 未配置" }, 500, JSON_HEADERS);
  }

  // 认证
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const queryToken = c.req.query("token") ?? "";
  if (bearer !== token && queryToken !== token) {
    return c.json({ error: "未授权" }, 401, JSON_HEADERS);
  }

  const contentType = c.req.header("content-type") ?? "";
  const prefix = c.req.query("path") ?? "uploads";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const stamp = Date.now();

  let fileName: string;
  let fileBody: BodyInit;
  let fileContentType: string;

  if (contentType.startsWith("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "缺少 file 字段" }, 400, JSON_HEADERS);
    }
    fileName = file.name;
    fileBody = file;
    fileContentType = file.type || "application/octet-stream";
  } else {
    const name = c.req.query("name");
    if (!name) {
      return c.json({ error: "raw body 模式需要 ?name=filename" }, 400, JSON_HEADERS);
    }
    fileName = name;
    fileBody = await c.req.arrayBuffer();
    fileContentType = contentType || "application/octet-stream";
  }

  const blobKey = `${prefix}/${date}/${stamp}-${fileName}`;
  const blob = await blobPut(
    env.BLOB_READ_WRITE_TOKEN,
    blobKey,
    fileBody,
    fileContentType
  );

  return c.json({
    url: applyBaseUrl(blob.url, env),
    key: blobKey,
    contentType: fileContentType,
  }, 200, JSON_HEADERS);
});

// ---------------------------------------------------------------------------
// 简单下载接口：GET /api/download/{...key}
// ---------------------------------------------------------------------------

app.get("/api/download/*", async (c) => {
  const env = c.env;
  const blobKey = c.req.path.replace(/^\/api\/download\//, "");
  if (!blobKey) return new Response("Not Found", { status: 404 });

  const info = await blobHead(env.BLOB_READ_WRITE_TOKEN, blobKey);
  if (!info) return new Response("Not Found", { status: 404 });

  const proxy = c.req.query("proxy") === "1";

  if (!proxy) {
    return Response.redirect(applyBaseUrl(info.url, env), 302);
  }

  const range = c.req.header("range");
  const upstream = await fetch(info.url, {
    headers: range ? { Range: range } : {},
  });

  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(h);
    if (value) headers.set(h, value);
  }
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(upstream.body, { status: upstream.status, headers });
});

export default app;