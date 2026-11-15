import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    'pg',
    '@prisma/adapter-pg',
    '@1sat/actions',
    '@1sat/client',
  ],
  turbopack: {
    resolveAlias: {
      fs: { browser: './src/lib/stubs/empty-module.ts' },
      path: { browser: './src/lib/stubs/empty-module.ts' },
    },
  },
};

export default nextConfig;
