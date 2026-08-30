import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * AWS SigV4 签名校验（针对 S3 path-style 请求）。
 *
 * @aws-sdk/client-s3 在发送请求时，会用 `Authorization: AWS4-HMAC-SHA256 ...` 头
 * 对「方法 + 路径 + 查询串 + 若干头 + bodyHash」计算签名。
 * 我们这里用自己配置的 secret key 重新计算一次，用 timing-safe 比较来校验，
 * 从而保证只有持有 S3_ACCESS_KEY / S3_SECRET_KEY 的调用方才能读写。
 */

export type VerifyOptions = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type VerifyResult = {
  /** 已通过 bodyHash 校验的原始字节（PUT 时为文件内容，其余为空） */
  body: Buffer;
  /** x-amz-content-sha256（用于回填 ETag 等） */
  payloadHash: string;
  /** 认证信息中的日期戳，如 20260830 */
  date: string;
};

/** AWS 约定的 URI 编码：使用 encodeURIComponent 并对三元组字符补 %XX 大写十六进制 */
function uriEscape(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 规范化头值：压缩连续空白为单个空格，并去掉首尾空白 */
function canonicalHeaderValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 依据原始 query string 重建规范查询串（AWS 要求按键排序并做 RFC3986 编码） */
function buildCanonicalQuery(rawSearch: string): string {
  if (!rawSearch) return "";
  const pairs: { key: string; value: string }[] = [];
  for (const part of rawSearch.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    pairs.push({ key, value });
  }
  pairs.sort((a, b) => (uriEscape(a.key) < uriEscape(b.key) ? -1 : 1));
  return pairs.map((p) => `${uriEscape(p.key)}=${uriEscape(p.value)}`).join("&");
}

/**
 * 校验请求签名。
 * 校验失败时抛出带原因的错误；成功返回 { body, payloadHash, date }。
 */
export async function verifySignature(
  request: Request,
  options: VerifyOptions
): Promise<VerifyResult> {
  const authorization = request.headers.get("authorization") ?? "";

  // AWS4-HMAC-SHA256 Credential=<AKID>/<date>/<region>/s3/aws4_request, SignedHeaders=..., Signature=...
  const match =
    /AWS4-HMAC-SHA256 Credential=([^/\s]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-fA-F]+)/.exec(
      authorization
    );
  if (!match) {
    throw new Error("请求缺少有效的 AWS4 签名头");
  }
  const [, accessKey, dateStamp, region, signedHeadersRaw, signatureHex] = match;

  if (accessKey !== options.accessKeyId) {
    throw new Error("AccessKey 不匹配");
  }

  const amzDate = request.headers.get("x-amz-date") ?? "";
  const payloadHash =
    request.headers.get("x-amz-content-sha256") ?? "UNSIGNED-PAYLOAD";

  const signedHeaders = signedHeadersRaw.split(";").map((h) => h.trim());

  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  // pathname 是「已经过编码的」请求路径，与客户端签名时所用路径一致，
  // 例如 /s3/my-bucket/i mages/a.jpg（空格为 %20）。
  const canonicalUri = url.pathname;
  const canonicalQuery = buildCanonicalQuery(url.search.slice(1));

  let canonicalHeaders = "";
  for (const name of signedHeaders) {
    const value = canonicalHeaderValue(request.headers.get(name) ?? "");
    canonicalHeaders += `${name}:${value}\n`;
  }
  const signedHeadersString = [...signedHeaders].sort().join(";");

  // 读取 body 并对 PUT 做内容一致性校验
  const body = Buffer.from(await request.arrayBuffer());
  if (payloadHash !== "UNSIGNED-PAYLOAD" && sha256Hex(body) !== payloadHash) {
    throw new Error("请求体哈希与 x-amz-content-sha256 不一致");
  }

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeadersString,
    payloadHash,
  ].join("\n");

  const amzScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    amzScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + options.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const computedSignature = hmac(kSigning, stringToSign).toString("hex");

  if (
    computedSignature.length !== signatureHex.length ||
    !timingSafeEqual(
      Buffer.from(computedSignature, "hex"),
      Buffer.from(signatureHex, "hex")
    )
  ) {
    throw new Error("签名校验失败");
  }

  return { body, payloadHash, date: dateStamp };
}