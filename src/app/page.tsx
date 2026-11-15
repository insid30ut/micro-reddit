import Link from 'next/link';
import { parseAppEnv } from '@/lib/config/env';
import { calculateRevenueAllocation } from '@/lib/payments/revenue-calculator';
import { WalletConnectPanel } from '@/components/wallet/wallet-connect-panel';

export default function HomePage() {
  const env = parseAppEnv();
  const sampleSplit = calculateRevenueAllocation(
    env.ACTIVITY_FEE_SATS,
    env.OWNER_SHARE_BPS,
    env.PLATFORM_SHARE_BPS
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <span className="inline-flex items-center rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-amber-400 ring-1 ring-inset ring-amber-500/30">
            Mode: {env.APP_MODE.toUpperCase()} (Default Safe Mode)
          </span>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white">
            BSV Community NFT &amp; Micropayment PoC
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Phase 3 Community NFT Minting — 1Sat Ordinals Ownership &amp; 70/30
            Revenue Routing on Bitcoin SV ({env.BSV_NETWORK}net config)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/communities"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            Browse Communities
          </Link>
          <Link
            href="/communities/new"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            + Create Community
          </Link>
        </div>
      </div>

      <section className="mb-8">
        <WalletConnectPanel appMode={env.APP_MODE} />
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold text-white">
            Configured Revenue Policy
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Revenue rights follow verified on-chain 1Sat Ordinal locking script
            ownership.
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-400">Paid Activity Fee</dt>
              <dd className="font-mono text-white">
                {sampleSplit.totalSatoshis.toLocaleString()} sats
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">
                Current NFT Owner ({sampleSplit.ownerShareBps / 100}%)
              </dt>
              <dd className="font-mono text-emerald-400">
                {sampleSplit.ownerSatoshis.toLocaleString()} sats
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">
                Platform Allocation ({sampleSplit.platformShareBps / 100}%)
              </dt>
              <dd className="font-mono text-sky-400">
                {sampleSplit.platformSatoshis.toLocaleString()} sats
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold text-white">
            Settlement &amp; Security Policy
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Mempool/observed transactions cannot authorize paid activities or
            transfer ownership prematurely.
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-400">Payment Intent Expiry</dt>
              <dd className="font-mono text-white">
                {env.PAYMENT_INTENT_EXPIRY_SECONDS}s
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Ownership Confirmations Req.</dt>
              <dd className="font-mono text-white">
                {env.OWNERSHIP_CONFIRMATIONS_REQUIRED} block(s)
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Payment Confirmations Req.</dt>
              <dd className="font-mono text-white">
                {env.PAYMENT_CONFIRMATIONS_REQUIRED} block(s)
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </main>
  );
}
