/**
 * AWS SigV4 签名校验（Web Crypto API 版本，适用于 Cloudflare Worker）。
 *
 * 与 Vercel 版逻辑一致，但使用 crypto.subtle 而非 node:crypto。
 */

export type VerifyOptions = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type VerifyResult = {
  body: ArrayBuffer;
  payloadHash: string;
  date: string;
};

function uriEscape(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function textEncoder() {
  return new TextEncoder();
}

async function hmacSha256(key: ArrayBufferLike, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return (await crypto.subtle.sign("HMAC", cryptoKey, textEncoder().encode(data))) as ArrayBuffer;
}

async function hmacSha256Hex(key: ArrayBufferLike, data: string): Promise<string> {
  const buf = await hmacSha256(key, data);
  return bufToHex(buf);
}

async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const input =
    typeof data === "string" ? textEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", input);
  return bufToHex(buf);
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bufFromHex(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}

function canonicalHeaderValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

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

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = bufFromHex(a);
  const bufB = bufFromHex(b);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

export async function verifySignature(
  request: Request,
  options: VerifyOptions
): Promise<VerifyResult> {
  const authorization = request.headers.get("authorization") ?? "";

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

  const signedHeaders = signedHeadersRaw
    .split(";")
    .map((h) => h.trim())
    .sort();

  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const canonicalUri = url.pathname;
  const canonicalQuery = buildCanonicalQuery(url.search.slice(1));

  let canonicalHeaders = "";
  for (const name of signedHeaders) {
    const value = canonicalHeaderValue(request.headers.get(name) ?? "");
    canonicalHeaders += `${name}:${value}\n`;
  }
  const signedHeadersString = signedHeaders.join(";");

  const body = await request.arrayBuffer();
  if (payloadHash !== "UNSIGNED-PAYLOAD") {
    const actual = await sha256Hex(body);
    if (actual !== payloadHash) {
      throw new Error("请求体哈希与 x-amz-content-sha256 不一致");
    }
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
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmacSha256(
    textEncoder().encode("AWS4" + options.secretAccessKey).buffer,
    dateStamp
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, "s3");
  const kSigning = await hmacSha256(kService, "aws4_request");
  const computedSignature = await hmacSha256Hex(kSigning, stringToSign);

  if (!timingSafeEqualHex(computedSignature, signatureHex.toLowerCase())) {
    throw new Error("签名校验失败");
  }

  return { body, payloadHash, date: dateStamp };
}