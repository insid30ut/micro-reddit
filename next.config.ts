import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    'pg',
    '@prisma/adapter-pg',
    '@1sat/actions',
    '@1sat/client',
  ],
};

export default nextConfig;
