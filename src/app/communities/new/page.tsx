import Link from 'next/link';
import { cookies } from 'next/headers';
import { getWalletAuthService } from '@/lib/auth/auth-service';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session-service';
import { parseAppEnv } from '@/lib/config/env';
import { CreateCommunityForm } from '@/components/communities/create-community-form';
import { WalletConnectPanel } from '@/components/wallet/wallet-connect-panel';

export const dynamic = 'force-dynamic';

export default async function CreateCommunityPage() {
  const env = parseAppEnv();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const authService = getWalletAuthService();

  let sessionContext = null;
  if (sessionToken) {
    try {
      sessionContext = await authService.getSessionContext(sessionToken);
    } catch {
      sessionContext = null;
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-emerald-400 ring-1 ring-inset ring-emerald-500/30">
            Screen 3 — Create Community ({env.APP_MODE.toUpperCase()} Mode)
          </span>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white">
            Create a Tokenized Community
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Register a community and mint its permanent 1Sat Ordinal NFT on{' '}
            {env.BSV_NETWORK}net.
          </p>
        </div>

        <Link
          href="/communities"
          className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          &larr; All Communities
        </Link>
      </div>

      {!sessionContext ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-5 text-sm text-amber-200">
            You must connect and authenticate a wallet before creating a community.
          </div>
          <WalletConnectPanel appMode={env.APP_MODE} />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-xs text-slate-300">
            Authenticated Creator:{' '}
            <span className="font-mono font-semibold text-white">
              {sessionContext.user.displayName ?? sessionContext.user.id}
            </span>{' '}
            ({sessionContext.activeWallet?.provider ?? 'wallet'})
          </div>
          <CreateCommunityForm />
        </div>
      )}
    </main>
  );
}
