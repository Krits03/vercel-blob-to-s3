import { put } from "@vercel/blob";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * 简单上传接口（非 S3 协议）。
 *
 * 两种用法：
 *   1. multipart/form-data：字段名 file，可选字段 path（自定义存储路径前缀）
 *   2. raw body：整个请求体作为文件，需带 ?name=xxx.jpg 查询参数指定文件名
 *
 * 认证：Authorization: Bearer <UPLOAD_TOKEN>
 *        或 query ?token=<UPLOAD_TOKEN>
 */

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checkAuth(request: Request): boolean {
  const token = process.env.UPLOAD_TOKEN ?? "";
  if (!token) return false;
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") ?? "";
  return safeCompare(bearer, token) || safeCompare(queryToken, token);
}

export async function POST(request: Request) {
  if (!checkAuth(request)) {
    return json({ error: "未授权：请提供正确的 UPLOAD_TOKEN" }, 401);
  }

  const contentType = request.headers.get("content-type") ?? "";
  const url = new URL(request.url);
  const prefix = url.searchParams.get("path") ?? "uploads";
  // 生成短日期前缀，避免冲突
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  let fileName: string | null = null;
  let fileBody: Blob;
  let fileContentType: string;

  if (contentType.startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return json({ error: "缺少 file 字段" }, 400);
    }
    fileName = file.name;
    fileBody = file;
    fileContentType = file.type || "application/octet-stream";
  } else {
    // raw body 模式
    const name = url.searchParams.get("name");
    if (!name) {
      return json({ error: "raw body 模式需要 ?name=filename 参数" }, 400);
    }
    fileName = name;
    fileBody = await request.blob();
    fileContentType = contentType || "application/octet-stream";
  }

  if (!fileName) {
    return json({ error: "无法确定文件名" }, 400);
  }

  // 组装存储路径：{prefix}/{date}/{timestamp}-{filename}
  const stamp = Date.now();
  const blobKey = `${prefix}/${date}/${stamp}-${fileName}`;

  const blob = await put(blobKey, fileBody, {
    access: "public",
    addRandomSuffix: false,
    contentType: fileContentType,
  });

  return json({
    url: blob.url,
    key: blobKey,
    pathname: blob.pathname,
    contentType: fileContentType,
    size: fileBody.size,
  }, 200);
}
