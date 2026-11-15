import Link from 'next/link';
import { getCommunityService } from '@/lib/communities/community-service';
import { parseAppEnv } from '@/lib/config/env';

export const dynamic = 'force-dynamic';

export default async function CommunitiesDirectoryPage() {
  const env = parseAppEnv();
  const communityService = getCommunityService();
  const communities = await communityService.listCommunities();

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-emerald-400 ring-1 ring-inset ring-emerald-500/30">
            Phase 3 — Community NFT Directory ({env.APP_MODE.toUpperCase()} Mode)
          </span>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white">
            Tokenized Communities
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Each active community is represented by a verified 1Sat Ordinal NFT whose
            current locking script receives 70% of paid activity fees.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            &larr; Home
          </Link>
          <Link
            href="/communities/new"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            + Create Community
          </Link>
        </div>
      </div>

      {communities.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center">
          <p className="text-sm text-slate-300">
            No communities have been created yet.
          </p>
          <Link
            href="/communities/new"
            className="mt-4 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            Create First Community
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {communities.map((community) => (
            <div
              key={community.id}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 transition hover:border-slate-700"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/communities/${community.slug}`}
                      className="text-lg font-semibold text-white hover:text-emerald-400"
                    >
                      {community.name}
                    </Link>
                    <span className="font-mono text-xs text-slate-400">
                      /{community.slug}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-300">
                    {community.description}
                  </p>
                </div>

                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    community.status === 'ACTIVE'
                      ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                      : 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
                  }`}
                >
                  {community.status}
                </span>
              </div>

              <dl className="mt-4 grid gap-3 border-t border-slate-800/80 pt-4 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-slate-400">Permanent NFT Origin</dt>
                  <dd className="mt-0.5 truncate font-mono text-slate-200">
                    {community.nft?.origin ?? 'Not yet minted'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Verified Owner Script</dt>
                  <dd className="mt-0.5 truncate font-mono text-emerald-400">
                    {community.currentOwnerScript ?? 'Awaiting verified mint'}
                  </dd>
                </div>
                <div className="flex items-end justify-end">
                  <Link
                    href={`/communities/${community.slug}`}
                    className="rounded bg-slate-800 px-3 py-1.5 font-medium text-slate-200 hover:bg-slate-700"
                  >
                    View Details &rarr;
                  </Link>
                </div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
