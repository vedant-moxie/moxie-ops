/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // pdfkit + playwright are server-only, keep them external from bundling
    serverComponentsExternalPackages: ["pdfkit", "playwright", "@prisma/client", "pdf-parse", "pdfjs-dist"],
    // run instrumentation.ts on server boot (Next 14) → starts the auto-sync timer
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
