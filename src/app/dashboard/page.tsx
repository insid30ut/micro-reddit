import Link from 'next/link';
import { cookies } from 'next/headers';
import { parseAppEnv } from '@/lib/config/env';
import { getWalletAuthService } from '@/lib/auth/auth-service';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session-service';
import { WalletConnectPanel } from '@/components/wallet/wallet-connect-panel';

export default async function DashboardPage() {
  const env = parseAppEnv();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const authService = getWalletAuthService();

  let sessionContext = null;
  if (sessionToken) {
    try {
      sessionContext = authService.getSessionContext(sessionToken);
    } catch {
      sessionContext = null;
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-emerald-400 ring-1 ring-inset ring-emerald-500/30">
            Screen 2 — Dashboard ({env.APP_MODE.toUpperCase()} Mode)
          </span>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white">
            Wallet &amp; Identity Dashboard
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Manage authenticated BSV wallet identities and linked provider connections.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          &larr; Back to Home
        </Link>
      </div>

      {sessionContext ? (
        <section className="mb-8 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold text-white">
            Authenticated Account Summary
          </h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-400">Account User ID</dt>
              <dd className="font-mono text-white">{sessionContext.user.id}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Display Name</dt>
              <dd className="font-mono text-white">
                {sessionContext.user.displayName ?? 'Unnamed'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Session Expires At</dt>
              <dd className="font-mono text-slate-300">
                {sessionContext.session.expiresAt.toISOString()}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Total Linked Wallets</dt>
              <dd className="font-mono text-emerald-400">
                {sessionContext.wallets.length}
              </dd>
            </div>
          </dl>
        </section>
      ) : (
        <section className="mb-8 rounded-xl border border-amber-500/30 bg-amber-950/20 p-6 text-sm text-amber-200">
          No active server session detected. Connect and verify a wallet below to start an authenticated session.
        </section>
      )}

      <WalletConnectPanel appMode={env.APP_MODE} />
    </main>
  );
}
