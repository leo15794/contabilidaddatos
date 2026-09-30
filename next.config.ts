import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Resúmenes de tarjeta en PDF pueden pesar varios MB.
      bodySizeLimit: "15mb",
    },
  },
};

export default nextConfig;
