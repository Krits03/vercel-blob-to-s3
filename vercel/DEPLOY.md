# Vercel 版部署文档

> 将 Vercel Blob 包装为 S3 兼容 + 简单 HTTP 双接口的对象存储网关，用于 Twikoo 评论系统图片上传。

## 目录

- [架构概览](#架构概览)
- [前置条件](#前置条件)
- [一、创建 Vercel Blob Store](#一创建-vercel-blob-store)
- [二、部署到 Vercel](#二部署到-vercel)
- [三、配置环境变量](#三配置环境变量)
- [四、验证部署](#四验证部署)
- [五、接入 Twikoo](#五接入-twikoo)
- [本地开发](#本地开发)
- [接口参考](#接口参考)
- [环境变量说明](#环境变量说明)
- [常见问题](#常见问题)

---

## 架构概览

```
Twikoo imgUploader (浏览器)
    │
    ├── S3 协议 (@aws-sdk/client-s3)
    │       └── PUT/GET/HEAD/DELETE  /s3/{bucket}/{key}  ← SigV4 签名校验
    │
    └── 简单 HTTP (fetch/curl)
            ├── POST  /api/upload?name=xxx          ← Bearer Token
            └── GET   /api/download/{key}           ← 302 重定向 / ?proxy=1 流式代理
                        │
                        ▼
                Vercel Blob (后端存储)
```

**技术栈：** Next.js 15 App Router (Route Handler) + `@vercel/blob` SDK + `node:crypto` (SigV4)

---

## 前置条件

1. **Vercel 账号**（免费版即可，Blob 有免费额度）
2. **Node.js >= 18**（本地开发需要）
3. **Twikoo 评论系统**已部署（Vercel / 其他均可）

---

## 一、创建 Vercel Blob Store

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 进入你的项目（或新建一个项目）→ **Storage** 标签页
3. 点击 **Create Database** → 选择 **Blob**
4. 起名如 `twikoo-images`，点击 **Create**
5. 创建完成后，在 Blob Store 详情页找到 **Copy Blob Read Write Token**
   - 这个 Token 就是 `BLOB_READ_WRITE_TOKEN`
   - 如果是同一个 Vercel 项目内绑定，Token 会自动注入环境变量，无需手动填写

> 注意：免费版 Blob 有容量和带宽限制，详见 [Vercel Blob 定价](https://vercel.com/docs/storage/vercel-blob#pricing)

---

## 二、部署到 Vercel

### 方式 A：通过 GitHub 自动部署（推荐）

```bash
# 1. 初始化 Git 仓库并推送
cd vercel/
git init
git add .
git commit -m "init: twikoo blob s3 gateway"
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后：
1. 登录 [Vercel Dashboard](https://vercel.com/new)
2. **Import** 你的 GitHub 仓库
3. **Root Directory** 设置为 `vercel`（因为仓库根目录下有 vercel/ 和 cf/ 两个子目录）
4. Framework Preset 会自动识别为 **Next.js**
5. 暂不点 Deploy，先去下一步配置环境变量

### 方式 B：通过 Vercel CLI 手动部署

```bash
cd vercel/
npm install -g vercel   # 如未安装
vercel                  # 首次部署（preview 环境）
vercel --prod           # 部署到生产环境
```

### 方式 C：直接在 Vercel Dashboard 创建项目

1. Vercel Dashboard → New Project → Import Git Repository
2. Root Directory → 选择 `vercel`
3. 点击 Deploy

---

## 三、配置环境变量

在 Vercel 项目的 **Settings → Environment Variables** 中添加以下变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `BLOB_READ_WRITE_TOKEN` | `vercel_blob_rw_xxx...` | 从 Blob Store 详情页复制 |
| `S3_ACCESS_KEY` | `twikoo-blob` | 自定义，用于 S3 签名校验的 AccessKey |
| `S3_SECRET_KEY` | `<强随机字符串>` | 用于 S3 签名校验的 SecretKey，务必保密 |
| `UPLOAD_TOKEN` | `<强随机字符串>` | 简单上传接口的 Bearer Token |

> 生成强随机字符串：`openssl rand -hex 32` 或 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 如果 Blob Store 绑定在同一 Vercel 项目

- `BLOB_READ_WRITE_TOKEN` 会被 Vercel 自动注入，无需手动添加
- 在 Storage 标签页确认 Blob Store 已连接到本项目

### 配置完成后

- 方式 A（GitHub）：推送一次代码或点 Redeploy 触发重新构建
- 方式 B（CLI）：再次运行 `vercel --prod`
- 部署成功后会得到域名，如 `https://twikoo-blob-s3.vercel.app`

---

## 四、验证部署

### 4.1 健康检查

打开浏览器访问项目根路径，应看到上传页面。

### 4.2 简单上传验证

```bash
# 用一个测试图片文件
curl -X POST "https://<你的域名>/api/upload?name=test.jpg&path=test" \
  -H "Authorization: Bearer <UPLOAD_TOKEN>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @test.jpg
```

预期返回：

```json
{
  "url": "https://xxx.public.blob.vercel-storage.com/test/20260830/1234-test.jpg",
  "key": "test/20260830/1234-test.jpg",
  "contentType": "image/jpeg",
  "size": 10240
}
```

### 4.3 简单下载验证

```bash
# 302 重定向模式
curl -L "https://<你的域名>/api/download/test/20260830/1234-test.jpg" -o downloaded.jpg

# 流式代理模式
curl "https://<你的域名>/api/download/test/20260830/1234-test.jpg?proxy=1" -o downloaded.jpg
```

### 4.4 S3 接口验证

```bash
# 安装 AWS CLI
pip install awscli

# 配置（使用你的 S3_ACCESS_KEY / S3_SECRET_KEY）
aws configure
# AWS Access Key ID: twikoo-blob
# AWS Secret Access Key: <你的 S3_SECRET_KEY>
# Default region name: auto
# Default output format: json

# 上传
aws s3 cp test.jpg \
  --endpoint-url https://<你的域名>/s3 \
  s3://comments/test.jpg

# 下载
aws s3 cp \
  --endpoint-url https://<你的域名>/s3 \
  s3://comments/test.jpg downloaded.jpg
```

---

## 五、接入 Twikoo

### 方式一：S3 协议接入（需要 @aws-sdk/client-s3）

在你的博客前端页面中：

```html
<script src="https://cdn.jsdelivr.net/npm/@aws-sdk/client-s3@3/dist-cjs/index.js"></script>
<script>
const { S3Client, PutObjectCommand } = AWS;

const ENDPOINT = 'https://<你的域名>/s3';
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

> **注意：** S3 密钥会暴露在浏览器端。由于本网关只允许写入指定路径且 Vercel Blob 的公开 URL 本身不可枚举，风险可控。如需更高安全性，建议使用方式二。

### 方式二：简单 HTTP 接口接入（推荐，无需额外 SDK）

```html
<script>
twikoo.init({
  envId: '<你的 Twikoo envId>',
  imgUploader: {
    async upload(file) {
      const res = await fetch('https://<你的域名>/api/upload?name=' + encodeURIComponent(file.name) + '&path=comments', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer <UPLOAD_TOKEN>',
          'Content-Type': file.type,
        },
        body: file,
      });
      if (!res.ok) throw new Error('上传失败: ' + res.status);
      const data = await res.json();
      return { url: data.url };
    },
  },
});
</script>
```

> **注意：** `UPLOAD_TOKEN` 会暴露在前端代码中。如需避免，可把上传逻辑移到 Twikoo 服务端（云函数）中，前端只调 Twikoo 的自定义接口。

### 方式三：网页手动上传

直接访问 `https://<你的域名>/`，在网页上输入 Token 后拖拽图片上传，复制返回的 URL 粘贴到评论中。

---

## 本地开发

```bash
cd vercel/

# 1. 安装依赖
npm install

# 2. 创建本地环境变量
cp .env.example .env.local
# 编辑 .env.local 填入真实值

# 3. 启动开发服务器
npm run dev
# 默认运行在 http://localhost:3000

# 4. 构建检查
npm run build
```

> 本地开发时 `BLOB_READ_WRITE_TOKEN` 必须手动填写（Vercel Blob 不会自动注入到本地环境）。

---

## 接口参考

### S3 兼容接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `PUT` | `/s3/{bucket}/{key}` | 上传对象（SigV4 签名） |
| `GET` | `/s3/{bucket}/{key}` | 下载对象（SigV4 签名，支持 Range） |
| `HEAD` | `/s3/{bucket}/{key}` | 获取对象元信息（SigV4 签名） |
| `DELETE` | `/s3/{bucket}/{key}` | 删除对象（SigV4 签名） |

### 简单 HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/upload?name={filename}&path={prefix}` | 上传文件（raw body，Bearer Token） |
| `POST` | `/api/upload?path={prefix}` | 上传文件（multipart/form-data，字段 `file`，Bearer Token） |
| `GET` | `/api/download/{key}` | 下载文件（302 重定向到 Blob CDN） |
| `GET` | `/api/download/{key}?proxy=1` | 下载文件（流式代理，支持 Range） |

---

## 环境变量说明

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `BLOB_READ_WRITE_TOKEN` | 是 | Vercel Blob 读写令牌。同项目绑定可自动注入，跨项目需手动填写 |
| `S3_ACCESS_KEY` | 是 | S3 签名校验用的 AccessKey，自定义值 |
| `S3_SECRET_KEY` | 是 | S3 签名校验用的 SecretKey，强随机字符串 |
| `UPLOAD_TOKEN` | 是 | 简单上传接口的 Bearer Token，强随机字符串 |

---

## 常见问题

### Q: 部署后访问 /api/upload 返回 401

确认 `UPLOAD_TOKEN` 环境变量已正确设置，且请求头中 `Authorization: Bearer <token>` 的值与环境变量完全一致。

### Q: S3 SDK 报 SignatureDoesNotMatch

1. 确认 `S3_ACCESS_KEY` 和 `S3_SECRET_KEY` 与客户端配置一致
2. 确认 `endpoint` 格式为 `https://<域名>/s3`（不含尾部斜杠）
3. 确认 `forcePathStyle: true` 已设置
4. Vercel 函数会自动解码 URL 编码的路径，如 key 含中文/空格需确认编码一致

### Q: 上传成功但图片无法显示

Vercel Blob 的公开 URL 格式为 `https://xxx.public.blob.vercel-storage.com/...`，确认该域名在你的网络环境下可访问。部分区域可能需要配置自定义域名。

### Q: Vercel Blob 免费额度用尽

免费版限制：1GB 存储 + 10GB 月带宽。超出后需升级到 Pro。也可改用 Cloudflare R2 等替代方案。

### Q: 能否限制上传文件大小

Vercel Serverless Function 默认限制 4.5MB 请求体。如需上传更大文件，可在 `vercel.json` 中配置 `maxDuration` 和使用 multipart 上传，或直接使用 Vercel Blob 的客户端直传 API。
