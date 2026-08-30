export const metadata = {
  title: "Twikoo Blob 图床",
  description: "S3 兼容的 Vercel Blob 网关",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
