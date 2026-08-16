/** @type {import('next').NextConfig} */
const coi = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

const nextConfig = {
  output: "export",
  reactStrictMode: true,
  // Applies under `next dev`/`next start`. Static export ignores this, so the
  // same headers are also declared in public/_headers and vercel.json for hosts.
  async headers() {
    return [{ source: "/:path*", headers: coi }];
  },
};

export default nextConfig;
