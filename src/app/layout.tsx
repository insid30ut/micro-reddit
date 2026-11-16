import type { Metadata } from 'next';
import { AppWalletProvider } from '@/context/wallet-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'BSV Community NFT & Micropayment PoC',
  description:
    'Tokenized Community Platform on Bitcoin SV with 1Sat Ordinals ownership and 70/30 micropayment revenue allocation.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const appMode = process.env.APP_MODE === 'live' ? 'live' : 'mock';
  const bsvNetwork = process.env.BSV_NETWORK === 'main' ? 'main' : 'test';
  // Mirrors the server's mainnet guardrail so the browser minting adapter can honor the
  // operator's explicit approval (APP_MODE=live + BSV_NETWORK=main + ALLOW_MAINNET_BROADCAST=true).
  const allowMainnetBroadcast =
    appMode === 'live' &&
    bsvNetwork === 'main' &&
    process.env.ALLOW_MAINNET_BROADCAST === 'true';

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <AppWalletProvider
          appMode={appMode}
          bsvNetwork={bsvNetwork}
          allowMainnetBroadcast={allowMainnetBroadcast}
        >
          {children}
        </AppWalletProvider>
      </body>
    </html>
  );
}
