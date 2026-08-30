"use client";

import { useState, useRef, useMemo } from "react";

type UploadResult = {
  url: string;
  key: string;
  contentType: string;
  size: number;
};

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input
        readOnly
        title={label}
        value={value}
        style={{ flex: 1, padding: 6, fontSize: 12, borderRadius: 4, border: "1px solid #ddd", fontFamily: "monospace" }}
      />
      <button
        onClick={() => navigator.clipboard.writeText(value)}
        style={{ padding: "6px 12px", borderRadius: 4, border: "none", background: "#0070f3", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" }}
      >
        复制
      </button>
    </div>
  );
}

export default function Home() {
  const [token, setToken] = useState("");
  const [path, setPath] = useState("uploads");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 绑定域名回调地址：自动拼接当前域名 + /api/download/{key}
  const gatewayUrl = useMemo(() => {
    if (!result) return "";
    if (typeof window === "undefined") return result.url;
    return `${window.location.origin}/api/download/${result.key}`;
  }, [result]);

  async function uploadFile(file: File) {
    if (!token) {
      setError("请先填写 UPLOAD_TOKEN");
      return;
    }
    setUploading(true);
    setError("");
    setResult(null);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch(`/api/upload?path=${encodeURIComponent(path)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `上传失败: ${res.status}`);
      }

      const data: UploadResult = await res.json();
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  return (
    <main style={{ maxWidth: 560, margin: "60px auto", fontFamily: "system-ui, sans-serif" }}>
      <h1>Vercel Blob 图床</h1>
      <p style={{ color: "#666" }}>简单上传 / 下载，后端 Vercel Blob</p>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 4, fontSize: 14 }}>
          UPLOAD_TOKEN
        </label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="填写访问令牌"
          style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 4, fontSize: 14 }}>
          存储路径前缀
        </label>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="uploads"
          style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
        />
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? "#0070f3" : "#ccc"}`,
          borderRadius: 12,
          padding: "40px 20px",
          textAlign: "center",
          cursor: "pointer",
          background: dragOver ? "#f0f7ff" : "#fafafa",
          transition: "all 0.2s",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadFile(file);
          }}
        />
        {uploading ? (
          <p>上传中...</p>
        ) : (
          <p>点击或拖拽图片到此处上传</p>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: 12, background: "#fee", borderRadius: 8, color: "#c00" }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 16, padding: 16, background: "#f0fff4", borderRadius: 8 }}>
          <p style={{ margin: "0 0 8px" }}>✅ 上传成功</p>
          <p style={{ fontSize: 13, color: "#666", margin: "0 0 4px" }}>Key: {result.key}</p>
          <p style={{ fontSize: 13, color: "#666", margin: "0 0 8px" }}>
            大小: {(result.size / 1024).toFixed(1)} KB · {result.contentType}
          </p>
          <img
            src={result.url}
            alt="preview"
            style={{ maxWidth: "100%", borderRadius: 8, marginBottom: 12 }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <div style={{ fontSize: 12, color: "#333", marginBottom: 4 }}>绑定域名回调（推荐用于 Twikoo S3_CDN_URL）</div>
              <CopyField value={gatewayUrl} label="网关回调地址" />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>Vercel Blob 原始地址</div>
              <CopyField value={result.url} label="Blob 原始地址" />
            </div>
          </div>
        </div>
      )}

      <footer style={{ marginTop: 60, textAlign: "center", fontSize: 12, color: "#999", borderTop: "1px solid #eee", paddingTop: 16 }}>
        <p style={{ margin: 0 }}>
          <a href="https://github.com/Krits03/vercel-blob-to-s3/" target="_blank" rel="noreferrer" style={{ color: "#0070f3", textDecoration: "none" }}>
            GitHub
          </a>
          <span style={{ margin: "0 4px" }}>Made by</span>
          <a href="https://github.com/Krits03/" target="_blank" rel="noreferrer" style={{ color: "#0070f3", textDecoration: "none" }}>
            Krits03
          </a>
        </p>
      </footer>
    </main>
  );
}
