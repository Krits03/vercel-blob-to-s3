# Twikoo Blob S3 Gateway

> 将 Vercel Blob 包装为 **S3 兼容协议 + 简单 HTTP** 双接口的对象存储网关，专为 [Twikoo](https://twikoo.js.org/) 评论系统的图片上传场景设计，无需改动 Twikoo 本身。

---
建议先看
- [我为什么要写这个项目](#为什么需要这个项目)

## 目录

- [项目简介](#项目简介)
- [核心功能](#核心功能)
- [我为什么要写这个项目](#为什么需要这个项目)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [架构原理](#架构原理)
- [两版实现对比](#两版实现对比)
- [接口一览](#接口一览)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [接入 Twikoo](#接入-twikoo)
- [限制与注意事项](#限制与注意事项)
- [详细部署文档](#详细部署文档)

---

## 项目简介

[Twikoo](https://twikoo.js.org/) 是一个流行的轻量级评论系统，支持通过 `imgUploader` 回调自定义图片上传逻辑。Twikoo 本身不提供图片存储，用户需要自行对接图床。

**Vercel Blob** 是 Vercel 提供的对象存储服务，简单易用、有免费额度，但它的 API 与 AWS S3 **不兼容**——既不支持 S3 的 XML 协议，也不支持 SigV4 签名认证。

本项目在 Vercel Blob 之上构建了一个**网关层**，对外暴露两套接口：

1. **S3 兼容接口** — 任何使用 `@aws-sdk/client-s3` 或 AWS CLI 的调用方都能直接读写
2. **简单 HTTP 接口** — 浏览器 `fetch` / `curl` 即可上传下载，无需 S3 SDK

两套接口共享同一个 Vercel Blob Store 后端，互不冲突。项目提供 **Vercel Serverless** 和 **Cloudflare Worker** 两个部署版本，功能对齐，按需选择。

---

## 核心功能

| 功能 | S3 兼容接口 | 简单 HTTP 接口 |
|------|:-----------:|:--------------:|
| 上传 (PUT / POST) | ✅ SigV4 签名 | ✅ Bearer Token |
| 下载 (GET) | ✅ SigV4 签名 + Range | ✅ 302 重定向 / 流式代理 |
| 元信息 (HEAD) | ✅ Vercel 版支持 | — |
| 删除 (DELETE) | ✅ SigV4 签名 | — |
| 网页上传 UI | — | ✅ Vercel 版内置 |
| 健康检查 | — | ✅ CF 版 `GET /` |
| Range 请求 (断点续传) | ✅ | ✅ 流式代理模式 |
| 长缓存 | ✅ `max-age=31536000` | ✅ |

---

## 我为什么要写这个项目

### 问题

之前一直用的Twikoo 的免费图床smms不能用了，本想用Cloudflare R2作为存储，但是首先于支付信息的绑定问题，一直用不了，后来在偶然间了解到了Vercel Blob ，又在AI盛行的当下，动用AI的力量，创造除了出了这个项目

| 方案 | 问题 |
|------|------|
| 直接用 Vercel Blob SDK | 只能在 Vercel 服务端调用，浏览器端无法直接使用 |
| 用 S3 SDK + AWS S3 / R2 | 需要单独开通 S3/R2 服务，额外成本和管理开销 |
| 用第三方图床 (sm.ms 等) | 稳定性和持久性不可控，可能跑路 |
| 自建图床 | 运维成本高 |

### 解决方案

本项目让你**继续使用 Vercel Blob 作为存储后端**（零额外存储成本、已在 Vercel 生态内），同时获得：

- **S3 协议兼容** — 已有 S3 调用代码零改动接入
- **简单 HTTP 接口** — 浏览器端一行 `fetch` 即可上传
- **双部署平台** — Vercel 或 Cloudflare 任选其一

```
                ┌──────────────────────────────────────────────┐
                │              本项目 (网关层)                   │
                │                                              │
  Twikoo ──────►│  S3 接口 (/s3/...)     简单接口 (/api/...)    │─────► Vercel Blob
  imgUploader   │  SigV4 签名校验        Bearer Token 认证      │       (存储)
                │  PUT/GET/HEAD/DELETE   POST upload / GET download
                └──────────────────────────────────────────────┘
```

---

## 技术栈

### Vercel 版 (`/vercel`)

| 层面 | 技术 | 说明 |
|------|------|------|
| 框架 | Next.js 15 (App Router) | 使用 Route Handler 实现 API |
| 运行时 | Node.js (Vercel Serverless) | `@vercel/blob` SDK 需要 Node 环境 |
| Blob SDK | `@vercel/blob` | 官方 SDK，直接调用 |
| 签名校验 | `node:crypto` | `createHmac` / `createHash` / `timingSafeEqual` |
| 前端 | React 19 | 内置网页上传页面 (拖拽 + 预览) |
| 语言 | TypeScript | 严格模式 |

### Cloudflare 版 (`/cf`)

| 层面 | 技术 | 说明 |
|------|------|------|
| 框架 | Hono 4 | 轻量 Web 框架，为 Worker 优化 |
| 运行时 | Cloudflare Workers | 边缘部署，全球低延迟 |
| Blob 调用 | Vercel Blob REST API | Worker 无法用 SDK，直接 fetch |
| 签名校验 | Web Crypto API | `crypto.subtle` (HMAC-SHA256 / SHA-256) |
| 语言 | TypeScript | 严格模式 |
| 构建 | Wrangler 3 | Cloudflare 官方 CLI |

---

## 项目结构

```
/workspace
├── vercel/                              # ── Vercel Serverless 版 ──
│   ├── app/
│   │   ├── s3/[...key]/route.ts         # S3 兼容接口 (PUT/GET/HEAD/DELETE)
│   │   ├── api/upload/route.ts          # 简单上传 (POST, raw body / multipart)
│   │   ├── api/download/[...key]/route.ts # 简单下载 (GET, 302 / proxy)
│   │   ├── layout.tsx                   # 根布局
│   │   └── page.tsx                     # 网页上传页面 (拖拽 + 预览 + 复制)
│   ├── lib/
│   │   └── sigv4.ts                     # SigV4 签名校验 (node:crypto)
│   ├── package.json
│   ├── next.config.mjs
│   ├── tsconfig.json
│   ├── .env.example
│   └── DEPLOY.md                        # Vercel 版部署文档
│
├── cf/                                  # ── Cloudflare Worker 版 ──
│   ├── src/
│   │   ├── index.ts                     # 入口：全部路由 + Blob REST 封装
│   │   └── sigv4.ts                     # SigV4 签名校验 (Web Crypto API)
│   ├── wrangler.toml                    # Worker 配置
│   ├── .dev.vars.example                # 本地开发环境变量
│   ├── package.json
│   ├── tsconfig.json
│   ├── .gitignore
│   └── DEPLOY.md                        # CF 版部署文档
│
└── README.md                            # ← 本文件
```

---

## 架构原理

### 1. 整体请求流程

以 Twikoo 图片上传为例，一个完整的请求经过以下步骤：

```
浏览器 (Twikoo imgUploader)
  │
  │  1. 构造请求 (携带文件 + 认证信息)
  │     ├─ S3 模式: @aws-sdk/client-s3 自动计算 SigV4 签名
  │     └─ HTTP 模式: 手动添加 Authorization: Bearer <token>
  │
  ▼
网关层 (Vercel Function / CF Worker)
  │
  │  2. 认证校验
  │     ├─ S3 模式: 用本地密钥重新计算签名 → timing-safe 比较
  │     └─ HTTP 模式: 比对 Bearer Token
  │
  │  3. 解析路径 → 提取 bucket + key
  │
  │  4. 调用后端
  │     ├─ Vercel 版: @vercel/blob SDK (put / head / del)
  │     └─ CF 版: fetch Vercel Blob REST API
  │
  ▼
Vercel Blob (存储后端)
  │
  │  5. 返回结果 (公开 URL / 元信息)
  │
  ▼
网关层
  │
  │  6. 构造响应
  │     ├─ S3 上传: 200 + ETag 头
  │     ├─ HTTP 上传: 200 + JSON { url, key, ... }
  │     └─ 下载: 流式透传 / 302 重定向
  │
  ▼
浏览器 → Twikoo 显示图片
```

### 2. SigV4 签名校验原理

S3 兼容接口的核心在于 **AWS Signature Version 4 (SigV4)** 校验。`@aws-sdk/client-s3` 在发送请求前，会按以下流程计算签名：

#### 2.1 客户端签名计算

```
Step 1: 构造规范请求 (Canonical Request)
─────────────────────────────────────────
HTTPMethod\n
CanonicalURI\n
CanonicalQueryString\n
CanonicalHeaders\n
SignedHeaders\n
HashedPayload

  • CanonicalURI: 请求路径 (URL 编码)
  • CanonicalQueryString: 查询参数按键名排序 + RFC3986 编码
  • CanonicalHeaders: 参与签名的头，格式 "name:value\n"，按名排序
  • SignedHeaders: 参与签名的头名列表，分号分隔，按名排序
  • HashedPayload: 请求体的 SHA-256 哈希 (或 "UNSIGNED-PAYLOAD")

Step 2: 构造待签字符串 (String to Sign)
───────────────────────────────────────
"AWS4-HMAC-SHA256\n" +
ISO8601_timestamp\n
CredentialScope\n
SHA256(CanonicalRequest)

  • CredentialScope: {date}/{region}/s3/aws4_request

Step 3: 派生签名密钥 (Signing Key)
─────────────────────────────────
kDate    = HMAC-SHA256("AWS4" + SecretKey, date)
kRegion  = HMAC-SHA256(kDate, region)
kService = HMAC-SHA256(kRegion, "s3")
kSigning = HMAC-SHA256(kService, "aws4_request")

Step 4: 计算签名
──────────────
signature = HMAC-SHA256(kSigning, StringToSign)

Step 5: 发送请求
──────────────
Authorization: AWS4-HMAC-SHA256
  Credential={AccessKey}/{date}/{region}/s3/aws4_request,
  SignedHeaders={headers},
  Signature={signature}
x-amz-date: {ISO8601_timestamp}
x-amz-content-sha256: {HashedPayload}
```

#### 2.2 服务端校验

网关收到请求后，执行**完全相同的计算流程**，用本地保存的 `S3_SECRET_KEY` 重新派生签名密钥并计算签名，最后用 **timing-safe 比较**防止时序攻击：

```typescript
// Vercel 版 (node:crypto)
if (
  computedSignature.length !== signatureHex.length ||
  !timingSafeEqual(
    Buffer.from(computedSignature, "hex"),
    Buffer.from(signatureHex, "hex")
  )
) {
  throw new Error("签名校验失败");
}

// CF 版 (Web Crypto API — 手动实现常量时间比较)
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = bufFromHex(a);
  const bufB = bufFromHex(b);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];  // XOR 累积差异
  }
  return diff === 0;
}
```

此外，如果请求携带了 `x-amz-content-sha256` 头（非 `UNSIGNED-PAYLOAD`），网关还会**重新计算请求体的 SHA-256 哈希**，验证其与头值一致，防止传输途中内容被篡改。

#### 2.3 Path-Style 寻址

网关使用 **path-style** 寻址（`forcePathStyle: true`），URL 格式为：

```
https://<域名>/s3/{bucket}/{key}
```

这是因为网关没有真实 bucket 概念——`bucket` 仅作为路径前缀用于逻辑分组，实际对象存储在 Vercel Blob 中路径为 `{bucket}/{key}` 的位置。

### 3. Vercel Blob 后端对接

#### Vercel 版 — 使用官方 SDK

```typescript
import { put, head, del } from "@vercel/blob";

// 上传
const blob = await put(`${bucket}/${key}`, fileBlob, {
  access: "public",
  addRandomSuffix: false,
  contentType,
});

// 查询元信息
const info = await head(`${bucket}/${key}`);

// 删除
await del(info.url);
```

#### CF 版 — 使用 REST API

Worker 环境无法加载 Node.js SDK，因此直接调用 Vercel Blob 的 HTTP API：

```typescript
// 上传
const res = await fetch(
  `https://blob.vercel-storage.com?pathname=${encodeURIComponent(pathname)}`,
  {
    method: "POST",
    body: fileBody,
    headers: {
      authorization: `Bearer ${BLOB_READ_WRITE_TOKEN}`,
      "x-content-type": contentType,
      "x-add-random-suffix": "false",
    },
  }
);

// 查询元信息 (HEAD)
const res = await fetch(
  `https://blob.vercel-storage.com?pathname=${encodeURIComponent(pathname)}`,
  { method: "HEAD", headers: { authorization: `Bearer ${token}` } }
);
// 从响应头读取: x-blob-url, x-blob-size, x-blob-content-type

// 删除
await fetch(`https://blob.vercel-storage.com?url=${encodeURIComponent(url)}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${token}` },
});
```

### 4. 简单 HTTP 接口认证

简单接口不使用 SigV4，而是标准的 Bearer Token 认证：

```
Authorization: Bearer <UPLOAD_TOKEN>
```

或通过查询参数传递（适用于不便设置请求头的场景）：

```
?token=<UPLOAD_TOKEN>
```

### 5. 下载代理模式

简单下载接口提供两种模式：

| 模式 | URL | 行为 | 适用场景 |
|------|-----|------|---------|
| 重定向 | `GET /api/download/{key}` | 302 跳转到 Blob CDN URL | 默认，最高性能 |
| 流式代理 | `GET /api/download/{key}?proxy=1` | Worker 中转返回文件内容 | 隐藏源 URL、自定义域名 |

流式代理模式通过 `fetch(upstreamUrl)` 获取 Blob CDN 内容，直接将 `upstream.body` 作为响应体返回（流式，不缓存在内存中），同时透传 `Content-Type`、`Content-Range`、`ETag` 等头，支持 **Range 请求**（断点续传）。

---

## 两版实现对比

| 维度 | Vercel 版 (`/vercel`) | CF 版 (`/cf`) |
|------|----------------------|---------------|
| **运行平台** | Vercel Serverless Functions | Cloudflare Workers |
| **Web 框架** | Next.js 15 App Router | Hono 4 |
| **Blob 调用** | `@vercel/blob` SDK | Vercel Blob REST API (fetch) |
| **签名加密** | `node:crypto` | `crypto.subtle` (Web Crypto) |
| **Timing-safe 比较** | `timingSafeEqual` | 手动 XOR 常量时间比较 |
| **网页上传 UI** | ✅ 内置 (React) | ❌ 纯 API |
| **HEAD /s3** | ✅ | ❌ |
| **自定义域名** | Vercel 项目设置 | `BLOB_BASE_URL` 变量 + CF 自定义域名 |
| **Secrets 管理** | Vercel 环境变量 | `wrangler secret put` |
| **免费额度** | Blob 1GB 存储 + 10GB/月带宽 | Worker 10 万次/天 请求 |
| **冷启动** | 有（Serverless） | 无（常驻边缘） |
| **部署命令** | `vercel --prod` | `wrangler deploy` |

---

## 接口一览

### S3 兼容接口

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `PUT` | `/s3/{bucket}/{key}` | SigV4 | 上传对象，返回 ETag |
| `GET` | `/s3/{bucket}/{key}` | SigV4 | 下载对象，支持 Range |
| `HEAD` | `/s3/{bucket}/{key}` | SigV4 | 获取元信息（仅 Vercel 版） |
| `DELETE` | `/s3/{bucket}/{key}` | SigV4 | 删除对象 |

### 简单 HTTP 接口

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| `POST` | `/api/upload?name={file}&path={prefix}` | Bearer Token | 上传 (raw body) |
| `POST` | `/api/upload?path={prefix}` | Bearer Token | 上传 (multipart, 字段 `file`) |
| `GET` | `/api/download/{key}` | 无 | 302 重定向到 Blob CDN |
| `GET` | `/api/download/{key}?proxy=1` | 无 | 流式代理，支持 Range |
| `GET` | `/` | 无 | 健康检查（CF 版）/ 网页 UI（Vercel 版） |

---

## 快速开始

### Vercel 版

```bash
cd vercel/
npm install
cp .env.example .env.local   # 填入真实值
npm run dev                   # http://localhost:3000
```

部署详见 [vercel/DEPLOY.md](vercel/DEPLOY.md)

### Cloudflare 版

```bash
cd cf/
npm install
cp .dev.vars.example .dev.vars  # 填入真实值
npm run dev                      # http://localhost:8787
```

部署详见 [cf/DEPLOY.md](cf/DEPLOY.md)

---

## 环境变量

| 变量名 | 平台 | 必填 | 说明 |
|--------|------|------|------|
| `BLOB_READ_WRITE_TOKEN` | 两者 | 是 | Vercel Blob 读写令牌 |
| `S3_ACCESS_KEY` | 两者 | 是 | S3 签名校验用 AccessKey |
| `S3_SECRET_KEY` | 两者 | 是 | S3 签名校验用 SecretKey |
| `UPLOAD_TOKEN` | 两者 | 是 | 简单上传接口 Bearer Token |
| `BLOB_BASE_URL` | 仅 CF | 否 | 覆盖 Blob 公开 URL 域名 |

> 生成强随机密钥：`openssl rand -hex 32`

---

## 接入 Twikoo

### 方式一：简单 HTTP 接口（推荐）

```javascript
twikoo.init({
  envId: '<你的 Twikoo envId>',
  imgUploader: {
    async upload(file) {
      const res = await fetch(
        'https://<你的域名>/api/upload?name=' +
          encodeURIComponent(file.name) + '&path=comments',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer <UPLOAD_TOKEN>',
            'Content-Type': file.type,
          },
          body: file,
        }
      );
      const data = await res.json();
      return { url: data.url };
    },
  },
});
```

### 方式二：S3 协议接口

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: 'https://<你的域名>/s3',
  region: 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: 'twikoo-blob',
    secretAccessKey: '<S3_SECRET_KEY>',
  },
});

twikoo.init({
  envId: '<你的 Twikoo envId>',
  imgUploader: {
    async upload(file) {
      const key = `images/${Date.now()}-${file.name}`;
      await s3.send(new PutObjectCommand({
        Bucket: 'comments',
        Key: key,
        Body: await file.arrayBuffer(),
        ContentType: file.type,
      }));
      return { url: `https://<你的域名>/s3/comments/${key}` };
    },
  },
});
```

### 方式三：网页手动上传（仅 Vercel 版）

访问 `https://<你的域名>/`，在网页上拖拽图片上传，复制 URL 粘贴到评论框。

---

## 限制与注意事项

| 限制 | 说明 |
|------|------|
| **请求体大小** | Vercel: 4.5MB (Serverless 默认)；CF Worker: 100MB |
| **Blob 免费额度** | 1GB 存储 + 10GB/月带宽 |
| **Worker 免费额度** | 10 万次请求/天 |
| **S3 接口范围** | 仅对象级操作 (PUT/GET/HEAD/DELETE)，不支持 ListObjects、Bucket 级操作 |
| **前端密钥暴露** | S3 密钥和 UPLOAD_TOKEN 会暴露在浏览器端代码中。Vercel Blob 的公开 URL 不可枚举，风险可控；如需更高安全性可将上传逻辑移至服务端 |
| **无防重复** | `addRandomSuffix: false` + 时间戳路径，理论上极低概率冲突，但不保证绝对唯一 |

---

## 详细部署文档

- **Vercel 版**：[vercel/DEPLOY.md](vercel/DEPLOY.md)
- **Cloudflare 版**：[cf/DEPLOY.md](cf/DEPLOY.md)

两份文档均包含：从零开始的完整部署步骤、环境变量配置、本地开发、验证测试、Twikoo 接入示例、常见问题排查。
