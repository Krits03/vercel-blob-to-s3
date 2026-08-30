# Cloudflare Worker 版部署文档

> 将 Vercel Blob 包装为 S3 兼容 + 简单 HTTP 双接口的对象存储网关，部署在 Cloudflare Workers 边缘网络，用于 Twikoo 评论系统图片上传。

## 目录

- [架构概览](#架构概览)
- [前置条件](#前置条件)
- [一、创建 Vercel Blob Store](#一创建-vercel-blob-store)
- [二、安装 Wrangler 并登录](#二安装-wrangler-并登录)
- [三、配置 Secrets](#三配置-secrets)
- [四、本地开发与测试](#四本地开发与测试)
- [五、部署到 Cloudflare](#五部署到-cloudflare)
- [六、验证部署](#六验证部署)
- [七、接入 Twikoo](#七接入-twikoo)
- [接口参考](#接口参考)
- [环境变量与 Secrets 说明](#环境变量与-secrets-说明)
- [可选配置](#可选配置)
- [常见问题](#常见问题)

---

## 架构概览

```
Twikoo imgUploader (浏览器)
    │
    ├── S3 协议 (@aws-sdk/client-s3)
    │       └── PUT/GET/DELETE  /s3/{bucket}/{key}   ← SigV4 签名校验 (Web Crypto)
    │
    └── 简单 HTTP (fetch/curl)
            ├── POST  /api/upload?name=xxx           ← Bearer Token
            └── GET   /api/download/{key}            ← 302 重定向 / ?proxy=1 流式代理
                        │
                        ▼
                Vercel Blob REST API (后端存储)
```

**技术栈：** Hono (Web 框架) + Web Crypto API (SigV4) + Vercel Blob REST API (fetch)

**与 Vercel 版的区别：**
- Worker 无法使用 `@vercel/blob` SDK，改为直接调用 Vercel Blob 的 REST API
- SigV4 使用 `crypto.subtle`（Web Crypto）而非 `node:crypto`
- 没有网页上传页面，纯 API 服务
- 部署在 Cloudflare 边缘节点，全球低延迟

---

## 前置条件

1. **Cloudflare 账号**（免费版即可，Workers 每天 10 万次免费请求）
2. **Vercel 账号** + 已创建 Blob Store（用于后端存储）
3. **Node.js >= 18**
4. **Twikoo 评论系统**已部署

---

## 一、创建 Vercel Blob Store

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 进入任意项目 → **Storage** → **Create Database** → 选择 **Blob**
3. 起名如 `twikoo-images`，创建
4. 在 Blob Store 详情页点击 **Copy Blob Read Write Token**
5. **保存好这个 Token**，后面需要作为 `BLOB_READ_WRITE_TOKEN` 配置到 Worker

> 此步骤与 Vercel 版完全相同。如果你已经有一套 Blob Store，可直接复用。

---

## 二、安装 Wrangler 并登录

```bash
cd cf/

# 安装依赖（包含 wrangler）
npm install

# 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 验证登录状态
npx wrangler whoami
```

> 如果你已有 Cloudflare API Token，也可以设置环境变量免登录：
> ```bash
> export CLOUDFLARE_API_TOKEN=你的API_Token
> ```

---

## 三、配置 Secrets

Worker 的敏感信息通过 `wrangler secret` 管理，不会写入代码或配置文件。

逐个设置以下 4 个 Secret（每次会交互式提示输入值）：

```bash
# Vercel Blob 读写令牌（从第一步获取）
npx wrangler secret put BLOB_READ_WRITE_TOKEN
# 粘贴: vercel_blob_rw_xxxxxxxxxxxx

# S3 签名校验用 AccessKey（自定义）
npx wrangler secret put S3_ACCESS_KEY
# 输入: twikoo-blob

# S3 签名校验用 SecretKey（强随机字符串）
npx wrangler secret put S3_SECRET_KEY
# 输入: <openssl rand -hex 32 生成的随机串>

# 简单上传接口的 Bearer Token（强随机字符串）
npx wrangler secret put UPLOAD_TOKEN
# 输入: <openssl rand -hex 32 生成的随机串>
```

生成强随机字符串：

```bash
openssl rand -hex 32
# 或
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 验证 Secrets 已设置

```bash
npx wrangler secret list
```

应看到 4 个 Secret 名称。

---

## 四、本地开发与测试

```bash
cd cf/

# 1. 创建本地环境变量文件
cp .dev.vars.example .dev.vars

# 2. 编辑 .dev.vars，填入真实值
#    BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx
#    S3_ACCESS_KEY=twikoo-blob
#    S3_SECRET_KEY=<你的密钥>
#    UPLOAD_TOKEN=<你的Token>
#    BLOB_BASE_URL=

# 3. 启动本地开发服务器
npm run dev
# 默认运行在 http://localhost:8787
```

### 本地测试上传

```bash
# 简单上传
curl -X POST "http://localhost:8787/api/upload?name=test.jpg&path=test" \
  -H "Authorization: Bearer <UPLOAD_TOKEN>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @test.jpg

# 健康检查
curl http://localhost:8787/
# {"ok":true,"service":"twikoo-blob-s3-cf","version":"1.0.0"}
```

---

## 五、部署到 Cloudflare

```bash
cd cf/

# 确认 wrangler.toml 中的 name 和 compatibility 配置
# name = "twikoo-blob-s3"  ← 可改为你的 Worker 名称

# 部署
npm run deploy
# 或
npx wrangler deploy
```

部署成功后输出示例：

```
Uploaded twikoo-blob-s3 (xxx sec)
  https://twikoo-blob-s3.<你的子域>.workers.dev
```

记下这个 URL，后续接入 Twikoo 时使用。

### 自定义域名（可选）

1. Cloudflare Dashboard → Workers & Pages → 你的 Worker → **Settings → Triggers**
2. 在 **Custom Domains** 中添加你的域名（如 `blob.example.com`）
3. Cloudflare 会自动配置 DNS 和 SSL

---

## 六、验证部署

### 6.1 健康检查

```bash
curl https://<你的Worker域名>/
# {"ok":true,"service":"twikoo-blob-s3-cf","version":"1.0.0"}
```

### 6.2 简单上传

```bash
curl -X POST "https://<你的Worker域名>/api/upload?name=test.jpg&path=test" \
  -H "Authorization: Bearer <UPLOAD_TOKEN>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @test.jpg
```

预期返回：

```json
{
  "url": "https://xxx.public.blob.vercel-storage.com/test/20260830/1234-test.jpg",
  "key": "test/20260830/1234-test.jpg",
  "contentType": "image/jpeg"
}
```

### 6.3 简单下载

```bash
# 302 重定向
curl -L "https://<你的Worker域名>/api/download/test/20260830/1234-test.jpg" -o downloaded.jpg

# 流式代理（支持 Range）
curl "https://<你的Worker域名>/api/download/test/20260830/1234-test.jpg?proxy=1" -o downloaded.jpg
```

### 6.4 S3 接口验证

```bash
pip install awscli
aws configure
# AWS Access Key ID: twikoo-blob
# AWS Secret Access Key: <你的 S3_SECRET_KEY>
# Default region name: auto

aws s3 cp test.jpg \
  --endpoint-url https://<你的Worker域名>/s3 \
  s3://comments/test.jpg

aws s3 cp \
  --endpoint-url https://<你的Worker域名>/s3 \
  s3://comments/test.jpg downloaded.jpg
```

---

## 七、接入 Twikoo

### 方式一：简单 HTTP 接口（推荐，无需额外 SDK）

```html
<script>
twikoo.init({
  envId: '<你的 Twikoo envId>',
  imgUploader: {
    async upload(file) {
      const res = await fetch(
        'https://<你的Worker域名>/api/upload?name=' +
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
      if (!res.ok) throw new Error('上传失败: ' + res.status);
      const data = await res.json();
      return { url: data.url };
    },
  },
});
</script>
```

### 方式二：S3 协议接入（需要 @aws-sdk/client-s3）

```html
<script src="https://cdn.jsdelivr.net/npm/@aws-sdk/client-s3@3/dist-cjs/index.js"></script>
<script>
const { S3Client, PutObjectCommand } = AWS;

const ENDPOINT = 'https://<你的Worker域名>/s3';
const BUCKET = 'comments';

const s3Client = new S3Client({
  endpoint: ENDPOINT,
  region: 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: 'twikoo-blob',
    secretAccessKey: '<你的 S3_SECRET_KEY>',
  },
});

twikoo.init({
  envId: '<你的 Twikoo envId>',
  imgUploader: {
    async upload(file) {
      const key = `images/${Date.now()}-${file.name}`;
      const body = await file.arrayBuffer();
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: file.type,
      }));
      return { url: `${ENDPOINT}/${BUCKET}/${key}` };
    },
  },
});
</script>
```

### 方式三：直接使用 Vercel Blob 公开 URL

上传成功后返回的 `url` 字段是 Vercel Blob 的公开 CDN 地址，可直接用于评论中的图片显示，无需经过 Worker 中转下载。

---

## 接口参考

### 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 返回服务信息 JSON |

### S3 兼容接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `PUT` | `/s3/{bucket}/{key}` | 上传对象（SigV4 签名） |
| `GET` | `/s3/{bucket}/{key}` | 下载对象（SigV4 签名，支持 Range） |
| `DELETE` | `/s3/{bucket}/{key}` | 删除对象（SigV4 签名） |

> 注意：CF 版当前未实现 `HEAD /s3/{key}`，如需要可补充。

### 简单 HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/upload?name={filename}&path={prefix}` | 上传文件（raw body，Bearer Token） |
| `POST` | `/api/upload?path={prefix}` | 上传文件（multipart/form-data，字段 `file`，Bearer Token） |
| `GET` | `/api/download/{key}` | 下载文件（302 重定向到 Blob CDN） |
| `GET` | `/api/download/{key}?proxy=1` | 下载文件（流式代理，支持 Range） |

---

## 环境变量与 Secrets 说明

### Secrets（通过 `wrangler secret put` 设置）

| 名称 | 必填 | 说明 |
|------|------|------|
| `BLOB_READ_WRITE_TOKEN` | 是 | Vercel Blob 读写令牌 |
| `S3_ACCESS_KEY` | 是 | S3 签名校验用 AccessKey |
| `S3_SECRET_KEY` | 是 | S3 签名校验用 SecretKey |
| `UPLOAD_TOKEN` | 是 | 简单上传接口 Bearer Token |

### Vars（在 `wrangler.toml` 中设置）

| 名称 | 必填 | 说明 |
|------|------|------|
| `BLOB_BASE_URL` | 否 | 覆盖 Vercel Blob 返回的公开 URL 域名。设为你的自定义域名可统一访问入口 |

---

## 可选配置

### 修改 Worker 名称

编辑 `wrangler.toml`：

```toml
name = "my-custom-worker-name"
```

### 调整兼容性日期

如遇到 API 兼容性问题，可更新 `compatibility_date`：

```toml
compatibility_date = "2025-01-01"
```

### 使用自定义域名作为公开 URL

如果你给 Vercel Blob 配了自定义域名（如 `cdn.example.com`），设置 `BLOB_BASE_URL`：

```toml
[vars]
BLOB_BASE_URL = "https://cdn.example.com"
```

这样所有返回的文件 URL 都会使用该域名，而不是 Vercel Blob 默认的 `*.public.blob.vercel-storage.com`。

### 查看部署日志

```bash
npx wrangler tail
# 实时查看 Worker 的 console.log 和错误输出
```

---

## 常见问题

### Q: 部署时报 "wrangler login" 错误

确保已执行 `npx wrangler login` 并在浏览器中完成授权。如使用 API Token，设置环境变量 `CLOUDFLARE_API_TOKEN`。

### Q: 上传返回 Blob API 错误 (401)

`BLOB_READ_WRITE_TOKEN` 无效或过期。到 Vercel Blob Store 详情页重新生成 Token，然后更新：
```bash
npx wrangler secret put BLOB_READ_WRITE_TOKEN
npx wrangler deploy
```

### Q: S3 SDK 报 SignatureDoesNotMatch

1. 确认 Worker 中 `S3_ACCESS_KEY` / `S3_SECRET_KEY` 与客户端配置完全一致
2. 确认 endpoint 格式为 `https://<域名>/s3`（不含尾部斜杠）
3. 确认 `forcePathStyle: true`
4. Cloudflare Worker 的 URL 解析与标准一致，如 key 含特殊字符需确认编码一致

### Q: Workers 免费额度够用吗

免费版每天 10 万次请求。Twikoo 图片上传属于低频操作，通常远够用。如需更多，Workers 付费版 $5/月 含 1000 万次请求。

### Q: Worker 有请求体大小限制吗

Cloudflare Workers 免费版限制请求体 100MB。Vercel Blob REST API 也有自己的限制。对于评论图片上传（通常 < 5MB）完全够用。

### Q: 上传的图片 URL 太长能否缩短

返回的 `url` 是 Vercel Blob 的完整 CDN 地址。如需短链，可以：
1. 使用 `BLOB_BASE_URL` 配置自定义域名
2. 使用 `/api/download/{key}` 形式的 URL（通过 Worker 302 重定向）
3. 自己搭一个短链服务映射 key → url

### Q: 如何更新部署

修改代码后重新部署：
```bash
npx wrangler deploy
```

更新 Secret：
```bash
npx wrangler secret put <名称>
# 无需重新部署，下次请求即生效
```

### Q: Vercel 版和 CF 版可以同时部署吗

可以，两者共享同一个 Vercel Blob Store，互不冲突。可以用 DNS 负载均衡或择一使用。
