'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface CommunityMintPanelProps {
  slug: string;
  communityStatus: string;
  appMode: 'mock' | 'live';
  bsvNetwork: 'main' | 'test';
  isCreator: boolean;
  defaultDestinationScript: string | null;
  canonicalMetadataJson: string;
  contentSha256Hex: string;
}

export function CommunityMintPanel({
  slug,
  communityStatus,
  appMode,
  bsvNetwork,
  isCreator,
  defaultDestinationScript,
  canonicalMetadataJson,
  contentSha256Hex,
}: CommunityMintPanelProps) {
  const router = useRouter();
  const [destinationScript, setDestinationScript] = useState(
    defaultDestinationScript ?? ''
  );
  const [submittedTxid, setSubmittedTxid] = useState('');
  const [submittedVout, setSubmittedVout] = useState(0);
  const [minting, setMinting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (communityStatus === 'ACTIVE') {
    return null;
  }

  async function handleMockMintAndVerify(): Promise<void> {
    setErrorMessage(null);
    setSuccessMessage(null);
    setMinting(true);

    try {
      const res = await fetch(
        `/api/communities/${encodeURIComponent(slug)}/nft/confirm-mint`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'mock-mint',
            ...(destinationScript.trim()
              ? { destinationP2PKHScript: destinationScript.trim() }
              : {}),
          }),
        }
      );

      const data = (await res.json()) as {
        verified?: boolean;
        activated?: boolean;
        nft?: { origin: string; currentOwnerScript: string };
        message?: string;
      };

      if (!res.ok) {
        throw new Error(data.message ?? 'Mock NFT minting failed.');
      }

      setSuccessMessage(
        `Verified 1Sat Ordinal NFT (${data.nft?.origin}) and activated community!`
      );
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'NFT minting failed.'
      );
    } finally {
      setMinting(false);
    }
  }

  async function handleVerifySubmittedTransaction(
    e: React.FormEvent
  ): Promise<void> {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setMinting(true);

    try {
      const res = await fetch(
        `/api/communities/${encodeURIComponent(slug)}/nft/confirm-mint`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'verify-tx',
            txid: submittedTxid.trim(),
            vout: submittedVout,
          }),
        }
      );

      const data = (await res.json()) as {
        verified?: boolean;
        activated?: boolean;
        nft?: { origin: string };
        message?: string;
      };

      if (!res.ok) {
        throw new Error(
          data.message ?? 'Independent backend verification rejected transaction.'
        );
      }

      setSuccessMessage(
        data.activated
          ? `Transaction verified (${data.nft?.origin}) and community activated!`
          : `Transaction observed (${data.nft?.origin}) awaiting block confirmations.`
      );
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Verification failed.'
      );
    } finally {
      setMinting(false);
    }
  }

  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="inline-flex items-center rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-300">
            Status: {communityStatus}
          </span>
          <h2 className="mt-2 text-lg font-semibold text-white">
            1Sat Ordinal Genesis NFT Minting &amp; Independent Verification
          </h2>
          <p className="mt-1 text-xs text-slate-300">
            This community will remain in{' '}
            <code className="text-amber-300">PENDING_MINT</code> until its 1Sat
            Ordinal inscription is minted and independently verified on{' '}
            <code className="text-emerald-300">{bsvNetwork}net</code>.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/80 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Deterministic 1Sat Ordinal Metadata Payload (Schema v1)
        </p>
        <pre className="mt-2 overflow-x-auto font-mono text-xs text-emerald-300">
          {canonicalMetadataJson}
        </pre>
        <p className="mt-2 font-mono text-[11px] text-slate-400">
          SHA-256 Digest: {contentSha256Hex}
        </p>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-300"
        >
          <span className="font-semibold">Mint / Verification Error:</span>{' '}
          {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-950/40 p-3 text-xs text-emerald-300">
          {successMessage}
        </div>
      )}

      {!isCreator ? (
        <p className="mt-4 text-xs text-amber-200">
          Only the authenticated original creator can mint and verify the genesis
          1Sat Ordinal NFT for this community.
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          {appMode === 'mock' && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <h3 className="text-sm font-semibold text-amber-300">
                Mock Mode — Mint &amp; Verify Simulated 1Sat Ordinal (No Mainnet Broadcast)
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                Constructs a genuine <code className="text-slate-200">ord</code>{' '}
                inscription locking script with the canonical metadata above and
                verifies it through <code className="text-slate-200">MintVerificationService</code>.
              </p>
              <div className="mt-3">
                <label
                  htmlFor="destination-p2pkh-script"
                  className="block text-xs font-medium text-slate-300"
                >
                  Recipient Owner P2PKH Locking Script (25-byte hex)
                </label>
                <input
                  id="destination-p2pkh-script"
                  type="text"
                  value={destinationScript}
                  onChange={(e) => setDestinationScript(e.target.value)}
                  placeholder="76a914...88ac"
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-emerald-300"
                />
              </div>
              <button
                type="button"
                disabled={minting}
                onClick={() => void handleMockMintAndVerify()}
                className="mt-3 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
              >
                {minting
                  ? 'Minting & Verifying...'
                  : 'Mint & Independently Verify Mock 1Sat Ordinal'}
              </button>
            </div>
          )}

          <form
            onSubmit={(e) => void handleVerifySubmittedTransaction(e)}
            className="rounded-lg border border-slate-800 bg-slate-900/80 p-4"
          >
            <h3 className="text-sm font-semibold text-slate-200">
              Submit Minted Transaction for Independent Backend Verification
            </h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <div className="sm:col-span-3">
                <label
                  htmlFor="verify-txid"
                  className="block text-xs text-slate-400"
                >
                  Transaction ID (64-hex chars)
                </label>
                <input
                  id="verify-txid"
                  type="text"
                  required
                  minLength={64}
                  maxLength={64}
                  value={submittedTxid}
                  onChange={(e) => setSubmittedTxid(e.target.value)}
                  placeholder="64-character hex transaction ID"
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-white"
                />
              </div>
              <div>
                <label
                  htmlFor="verify-vout"
                  className="block text-xs text-slate-400"
                >
                  Output Index (vout)
                </label>
                <input
                  id="verify-vout"
                  type="number"
                  min={0}
                  value={submittedVout}
                  onChange={(e) =>
                    setSubmittedVout(Number.parseInt(e.target.value, 10) || 0)
                  }
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-white"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={minting}
              className="mt-3 rounded-lg border border-emerald-500/50 bg-emerald-600/20 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-50"
            >
              Verify Inscription &amp; Activate Community
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
