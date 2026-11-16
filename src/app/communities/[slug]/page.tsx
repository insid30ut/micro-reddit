import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getWalletAuthService } from '@/lib/auth/auth-service';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session-service';
import {
  CommunityServiceError,
  getCommunityService,
} from '@/lib/communities/community-service';
import { parseAppEnv } from '@/lib/config/env';
import { serializeCommunityNftMetadataDeterministically } from '@/lib/ordinals/metadata';
import { CommunityMintPanel } from '@/components/communities/community-mint-panel';

export const dynamic = 'force-dynamic';

export default async function CommunityDetailsPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const env = parseAppEnv();
  const communityService = getCommunityService();

  let community;
  try {
    community = await communityService.getCommunityBySlugOrId(slug);
  } catch (error) {
    if (error instanceof CommunityServiceError && error.statusCode === 404) {
      notFound();
    }
    throw error;
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  let sessionContext = null;
  if (sessionToken) {
    try {
      sessionContext = await getWalletAuthService().getSessionContext(
        sessionToken
      );
    } catch {
      sessionContext = null;
    }
  }

  const isCreator = sessionContext?.user.id === community.originalCreatorId;
  const serializedMetadata = serializeCommunityNftMetadataDeterministically({
    communityId: community.id,
    name: community.name,
    description: community.description,
    artworkUrl: community.artworkUrl,
  });

  const ownerSharePct = (community.revenuePolicy?.ownerShareBps ?? env.OWNER_SHARE_BPS) / 100;
  const platformSharePct =
    (community.revenuePolicy?.platformShareBps ?? env.PLATFORM_SHARE_BPS) / 100;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider ${
                community.status === 'ACTIVE'
                  ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30'
                  : 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30'
              }`}
            >
              Status: {community.status}
            </span>
            {community.nft?.isMock && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-amber-300 ring-1 ring-inset ring-amber-500/30">
                Simulated Mock Inscription
              </span>
            )}
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white">
            {community.name}
          </h1>
          <p className="mt-1 font-mono text-xs text-slate-400">
            Slug: /{community.slug} &bull; ID: {community.id}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/communities"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            &larr; All Communities
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            Dashboard
          </Link>
        </div>
      </div>

      <section className="mb-8 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-semibold text-white">About Community</h2>
        <p className="mt-2 text-sm text-slate-300">{community.description}</p>
        {community.artworkUrl && (
          <p className="mt-3 text-xs text-slate-400">
            Artwork Reference:{' '}
            <span className="font-mono text-sky-400">{community.artworkUrl}</span>
          </p>
        )}
      </section>

      {community.status !== 'ACTIVE' && (
        <div className="mb-8">
          <CommunityMintPanel
            slug={community.slug}
            communityStatus={community.status}
            appMode={env.APP_MODE}
            bsvNetwork={env.BSV_NETWORK}
            isCreator={isCreator}
            defaultDestinationScript={
              sessionContext?.activeWallet?.payoutScript ?? null
            }
            canonicalMetadataJson={serializedMetadata.canonicalJson}
            contentSha256Hex={serializedMetadata.contentSha256Hex}
            pendingMint={
              community.nft &&
              community.nft.mintStatus !== 'VERIFIED' &&
              community.nft.mintStatus !== 'FAILED'
                ? {
                    origin: community.nft.origin,
                    originTxid: community.nft.originTxid,
                    originVout: community.nft.originVout,
                    mintStatus: community.nft.mintStatus,
                    confirmationStatus: community.nft.confirmationStatus,
                  }
                : null
            }
          />
        </div>
      )}

      <section className="mb-8 grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold text-white">
            1Sat Ordinal NFT &amp; On-Chain Ownership
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Ownership is determined strictly by the verified on-chain locking
            script of the NFT output.
          </p>

          {community.nft ? (
            <dl className="mt-4 space-y-3 text-xs">
              <div>
                <dt className="text-slate-400">Permanent Origin Identifier</dt>
                <dd className="mt-0.5 break-all font-mono text-white">
                  {community.nft.origin}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">Current Outpoint</dt>
                <dd className="mt-0.5 break-all font-mono text-slate-200">
                  {community.nft.currentTxid}_{community.nft.currentVout}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400">
                  Authoritative Current Owner Locking Script (P2PKH)
                </dt>
                <dd className="mt-0.5 break-all font-mono text-emerald-400">
                  {community.currentOwnerScript ?? community.nft.currentOwnerScript}
                </dd>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <div>
                  <dt className="text-slate-400">Mint Status</dt>
                  <dd className="font-mono text-white">
                    {community.nft.mintStatus}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Confirmation Status</dt>
                  <dd className="font-mono text-emerald-400">
                    {community.nft.confirmationStatus}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Script Classification</dt>
                  <dd className="font-mono text-white">
                    {community.nft.scriptType}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Payout Routable</dt>
                  <dd className="font-mono text-emerald-400">
                    {community.nft.isPayoutRoutable ? 'YES (Verified P2PKH)' : 'NO'}
                  </dd>
                </div>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-xs text-amber-300">
              No verified 1Sat Ordinal NFT recorded yet. Community is in{' '}
              <code>{community.status}</code> state.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold text-white">
            Revenue Policy &amp; Paid Activity Routing
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Revenue follows the current verified NFT locking script rather than
            the historical creator account.
          </p>

          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-400">Current NFT Holder Share</dt>
              <dd className="font-mono text-emerald-400">{ownerSharePct}%</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Platform Share</dt>
              <dd className="font-mono text-sky-400">{platformSharePct}%</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Configured Activity Fee</dt>
              <dd className="font-mono text-white">
                {env.ACTIVITY_FEE_SATS.toLocaleString()} sats
              </dd>
            </div>
          </dl>

          <div className="mt-6 border-t border-slate-800 pt-4">
            <button
              type="button"
              disabled
              className="w-full cursor-not-allowed rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-xs font-medium text-slate-400"
            >
              Submit Paid Activity (Enabled in Phase 5)
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
