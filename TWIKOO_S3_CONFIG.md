# Twikoo S3 插件配置指南

> 对接本项目（Twikoo Blob S3 Gateway）的 Twikoo 管理面板 S3 / R2 / MinIO 插件配置说明。

---

## 前提条件

- 已部署本项目（Vercel 版或 CF 版），并能访问网关域名
- 已在网关中配置好以下环境变量，并记录它们的值：
  - `S3_ACCESS_KEY` — S3 签名校验用 AccessKey
  - `S3_SECRET_KEY` — S3 签名校验用 SecretKey
- Twikoo 版本 >= 1.7.15（S3 插件于 [PR #895](https://github.com/twikoojs/twikoo/pull/895) 合入）

---

## 工作原理

Twikoo 的 S3 插件**在服务端**完成签名和上传，S3 密钥不会暴露到浏览器：

```
浏览器                    Twikoo 服务端                    本项目网关                 Vercel Blob
  │                           │                              │                          │
  │  1. 选择图片 (base64)     │                              │                          │
  │ ─────────────────────────►│                              │                          │
  │                           │  2. 用 S3_SECRET_ACCESS_KEY  │                          │
  │                           │     计算 SigV4 签名           │                          │
  │                           │  3. PUT /s3/{bucket}/{key}   │                          │
  │                           │ ────────────────────────────►│  4. 校验签名              │
  │                           │                              │  5. put() 到 Blob         │
  │                           │                              │ ─────────────────────────►│
  │                           │                              │  6. 返回公开 URL           │
  │                           │  7. 返回 { url: fileUrl }    │◄─────────────────────────│
  │  8. 显示图片 <img src>    │◄────────────────────────────│                              │
  │ ──────────────────────────────────────────────►  浏览器直接加载 fileUrl (无需签名)
```

关键点：**上传走 S3 签名接口，但图片显示 URL 不走 S3 接口**。因为浏览器 `<img>` 标签无法携带 SigV4 签名头，所以 `S3_CDN_URL` 必须指向网关的**简单下载接口**（`/api/download/...`），该接口无需认证，会 302 重定向到 Vercel Blob CDN。

---

## 配置项详解

在 Twikoo 管理面板 → 插件 → IMAGE_CDN 选择 **"S3 / R2 / MinIO"** 后，依次填写以下字段。

下文以网关域名 `https://blob.example.com` 为例，请替换为你的实际域名。

### S3_REGION

```
us-east-1
```

**可填任意值。** 本网关不依赖区域，该值仅参与 SigV4 签名计算，只要客户端和服务端一致即可。填 `us-east-1` 或 `auto` 都行。

---

### S3_BUCKET

```
comments
```

**自定义逻辑前缀。** 网关没有真实 bucket 概念，此值仅作为 Vercel Blob 中的存储路径前缀。填 `comments`、`twikoo`、`images` 等任意名称均可。后续所有图片都会存储在 Blob 的 `{此值}/{路径前缀}/{文件名}` 下。

---

### S3_ACCESS_KEY_ID

```
<填入网关中 S3_ACCESS_KEY 的值>
```

必须与网关环境变量 `S3_ACCESS_KEY` 完全一致。例如网关配的是 `twikoo-blob`，这里就填 `twikoo-blob`。

---

### S3_SECRET_ACCESS_KEY

```
<填入网关中 S3_SECRET_KEY 的值>
```

必须与网关环境变量 `S3_SECRET_KEY` 完全一致。

---

### S3_ENDPOINT

```
https://blob.example.com/s3
```

网关的 S3 兼容接口地址。格式为 `https://<你的域名>/s3`，**不要带尾部斜杠**。

Twikoo 在 `S3_FORCE_PATH_STYLE=true` 时会构造上传 URL 为：
```
{S3_ENDPOINT}/{S3_BUCKET}/{key}
= https://blob.example.com/s3/comments/{key}
```
这正好命中网关的 `/s3/{bucket}/{...key}` 路由。

---

### S3_FORCE_PATH_STYLE

```
true
```

**必须为 `true`**（也是默认值）。设为 `true` 后，Twikoo 会将 `S3_BUCKET` 拼入 URL 路径（path-style），而不是作为子域名（virtual-hosted-style）。

> Twikoo 源码逻辑：`String(config.S3_FORCE_PATH_STYLE).trim().toLowerCase() !== 'false'` 即为 `true`。只要不填 `false` 就行，但建议显式填 `true`。

---

### S3_CDN_URL

```
https://blob.example.com/api/download/comments
```

**最关键的一项！** 这是图片显示时浏览器加载的 URL 基础地址。

> **为什么不能留空？** 如果留空，Twikoo 会用 `{S3_ENDPOINT}/{S3_BUCKET}/{key}` 作为图片 URL（如 `https://blob.example.com/s3/comments/images/twikoo/xxx.jpg`）。但网关的 S3 GET 接口**需要 SigV4 签名认证**，浏览器 `<img>` 标签无法携带签名头，图片将无法加载（返回 403）。
>
> **正确做法**：指向网关的简单下载接口 `/api/download/{S3_BUCKET}`，该接口无需认证，会 302 重定向到 Vercel Blob CDN。

Twikoo 构造的图片显示 URL 为：
```
{S3_CDN_URL}/{key}
= https://blob.example.com/api/download/comments/{S3_PATH_PREFIX}/{文件名}
```

网关的下载接口收到 `/api/download/comments/images/twikoo/xxx.jpg` 后，用 `comments/images/twikoo/xxx.jpg` 作为 Blob 路径查询，302 重定向到 Vercel Blob 公开 CDN 地址。浏览器自动跟随重定向加载图片。

**规则**：`S3_CDN_URL = https://<域名>/api/download/<S3_BUCKET 的值>`

---

### S3_PATH_PREFIX

```
images/twikoo
```

**可选。** 图片在 Blob 中的存储路径前缀（不包含 bucket）。留空则存储在 bucket 根目录。

最终图片在 Vercel Blob 中的完整路径为：
```
{S3_BUCKET}/{S3_PATH_PREFIX}/{文件名}
= comments/images/twikoo/20260830-abc123.jpg
```

---

## 配置示例汇总

以网关部署在 `https://blob.example.com` 为例：

| 配置项 | 值 |
|--------|-----|
| IMAGE_CDN (IMAGE_SERVICE) | `S3 / R2 / MinIO` |
| S3_REGION | `us-east-1` |
| S3_BUCKET | `comments` |
| S3_ACCESS_KEY_ID | `twikoo-blob` |
| S3_SECRET_ACCESS_KEY | `<你的 S3_SECRET_KEY>` |
| S3_ENDPOINT | `https://blob.example.com/s3` |
| S3_FORCE_PATH_STYLE | `true` |
| S3_CDN_URL | `https://blob.example.com/api/download/comments` |
| S3_PATH_PREFIX | `images/twikoo` |

---

## 验证流程

### 1. 上传验证

在 Twikoo 评论区点击图片按钮，选择一张图片上传。如果配置正确，应该：

- 图片上传成功，评论中显示图片
- 浏览器开发者工具 → Network 中能看到：
  1. 一个 `PUT` 请求到 `https://blob.example.com/s3/comments/images/twikoo/xxx.jpg`，返回 200
  2. 一个 `GET` 请求到 `https://blob.example.com/api/download/comments/images/twikoo/xxx.jpg`，返回 302
  3. 浏览器跟随 302，从 Vercel Blob CDN 加载图片

### 2. 常见错误排查

| 现象 | 原因 | 解决方案 |
|------|------|---------|
| 上传返回 403 SignatureDoesNotMatch | `S3_ACCESS_KEY_ID` 或 `S3_SECRET_ACCESS_KEY` 与网关不一致 | 核对网关环境变量 `S3_ACCESS_KEY` / `S3_SECRET_KEY` |
| 上传返回 403 请求缺少有效的 AWS4 签名头 | Twikoo 版本过低，不支持 S3 插件 | 升级 Twikoo >= 1.7.15 |
| 上传成功但图片无法显示 (403) | `S3_CDN_URL` 留空，浏览器走了需要签名的 S3 GET 接口 | 设置 `S3_CDN_URL` 为 `https://<域名>/api/download/<S3_BUCKET>` |
| 上传成功但图片无法显示 (404) | `S3_CDN_URL` 路径与 `S3_BUCKET` 不匹配 | 确保 `S3_CDN_URL` 末尾的路径段与 `S3_BUCKET` 一致 |
| 上传返回 500 InternalError | 网关未配置 `BLOB_READ_WRITE_TOKEN` 或 Vercel Blob 未连接 | 检查网关环境变量，确认 Blob Store 已连接 |
| 上传返回 413 | 请求体超过平台限制 | Vercel: 4.5MB；CF Worker: 100MB。Twikoo 限制图片 10MB |

---

## 两种部署版本的差异

配置方式完全相同，只需替换域名：

| | Vercel 版 | CF 版 |
|---|-----------|-------|
| S3_ENDPOINT | `https://<vercel域名>/s3` | `https://<worker域名>/s3` |
| S3_CDN_URL | `https://<vercel域名>/api/download/comments` | `https://<worker域名>/api/download/comments` |
| 密钥来源 | Vercel 环境变量 `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `wrangler secret put S3_ACCESS_KEY` / `S3_SECRET_KEY` |

---

## 安全说明

- **S3 密钥不暴露在前端**：Twikoo 的 S3 上传在服务端完成，密钥存储在 Twikoo 后端配置中，浏览器代码中不会出现。
- **下载接口无需认证**：`/api/download/` 接口不需要任何认证，任何人知道 URL 即可下载。Vercel Blob 的公开 URL 本身也不可枚举（路径包含随机 store ID），安全性可接受。
- **上传接口有签名保护**：只有持有 `S3_ACCESS_KEY` + `S3_SECRET_KEY` 的 Twikoo 服务端才能上传/删除文件。
