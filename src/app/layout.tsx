import type { Metadata } from 'next';
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
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
