'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppWallet } from '@/context/wallet-context';
import type { OrdinalMetadata } from '@/types/wallet';

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

interface MintIntentApiResponse {
  community?: {
    id: string;
    slug: string;
    name: string;
  };
  serverNetwork?: 'main' | 'test';
  mintIntent?: {
    metadata: OrdinalMetadata;
    canonicalJson: string;
    contentBase64: string;
    contentSha256Hex: string;
    contentType: string;
    mapAttributes: Record<string, string>;
  };
  message?: string;
}

interface ConfirmMintApiResponse {
  message?: string;
  community?: {
    status: string;
  };
  nft?: {
    origin: string;
    originTxid: string;
    originVout: number;
    mintStatus: string;
    confirmationStatus: string;
  };
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
  const {
    selectedProvider,
    connectionState,
    activeAdapter,
    activeWalletInterface,
    capabilities,
    currentPayoutScript,
    sessionData,
    syncRuntimeConfig,
    reconnectActiveWallet,
    deriveVerifiedDestination,
    mintCommunityOrdinal,
  } = useAppWallet();

  useEffect(() => {
    syncRuntimeConfig({ appMode, bsvNetwork });
  }, [appMode, bsvNetwork, syncRuntimeConfig]);

  const effectiveDestinationScript =
    currentPayoutScript ?? defaultDestinationScript ?? '';

  const [manualDestinationScript, setManualDestinationScript] = useState(
    effectiveDestinationScript
  );
  const [txidInput, setTxidInput] = useState('');
  const [voutInput, setVoutInput] = useState('0');
  const [mintStep, setMintStep] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelSuccess, setPanelSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (effectiveDestinationScript && !manualDestinationScript) {
      setManualDestinationScript(effectiveDestinationScript);
    }
  }, [effectiveDestinationScript, manualDestinationScript]);

  const activeProviderLabel =
    activeAdapter?.provider ??
    sessionData?.activeWallet?.provider ??
    selectedProvider ??
    'None';

  async function handleLiveWalletMint() {
    setSubmitting(true);
    setPanelError(null);
    setPanelSuccess(null);

    try {
      setMintStep('1/4 Checking verified BRC-42 payment destination...');
      let ownerScript = currentPayoutScript ?? '';
      if (!ownerScript) {
        const derived = await deriveVerifiedDestination();
        ownerScript = derived.lockingScript;
        setManualDestinationScript(ownerScript);
      }

      setMintStep('2/4 Fetching authoritative mint intent from server...');
      const intentRes = await fetch(`/api/communities/${slug}/nft/mint-intent`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const intentPayload = (await intentRes.json()) as MintIntentApiResponse;

      if (!intentRes.ok || !intentPayload.mintIntent) {
        throw new Error(
          intentPayload.message ??
            'Failed to prepare authoritative Community NFT mint intent.'
        );
      }

      setMintStep(
        `3/4 Requesting ${activeAdapter?.provider ?? 'wallet'} signature to build 1Sat Ordinal...`
      );
      const mintResult = await mintCommunityOrdinal({
        contentBase64: intentPayload.mintIntent.contentBase64,
        contentType: intentPayload.mintIntent.contentType,
        metadata: intentPayload.mintIntent.metadata,
        destinationScript: ownerScript,
      });

      setMintStep(
        `4/4 Verifying minted output ${mintResult.txid}:${mintResult.vout} on server...`
      );
      const confirmRes = await fetch(
        `/api/communities/${slug}/nft/confirm-mint`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            action: 'verify-tx',
            txid: mintResult.txid,
            vout: mintResult.vout,
            expectedOrigin: mintResult.origin,
          }),
        }
      );

      const confirmPayload = (await confirmRes.json()) as ConfirmMintApiResponse;

      if (!confirmRes.ok || !confirmPayload.nft) {
        throw new Error(
          confirmPayload.message ??
            'Server failed to verify the submitted mint transaction.'
        );
      }

      setPanelSuccess(
        `Community NFT minted and verified! Origin: ${confirmPayload.nft.origin} (mintStatus: ${confirmPayload.nft.mintStatus}, confirmation: ${confirmPayload.nft.confirmationStatus}).`
      );
      setMintStep(null);
      router.refresh();
    } catch (err) {
      setPanelError(
        err instanceof Error ? err.message : 'Community NFT minting failed.'
      );
      setMintStep(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMockMint(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setPanelError(null);
    setPanelSuccess(null);

    try {
      let destination =
        manualDestinationScript.trim() || effectiveDestinationScript;
      if (!destination && activeAdapter) {
        const derived = await deriveVerifiedDestination();
        destination = derived.lockingScript;
        setManualDestinationScript(destination);
      }

      const res = await fetch(`/api/communities/${slug}/nft/confirm-mint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'mock-mint',
          ...(destination ? { destinationP2PKHScript: destination } : {}),
        }),
      });
      const payload = (await res.json()) as ConfirmMintApiResponse;
      if (!res.ok || !payload.nft) {
        throw new Error(payload.message ?? 'Mock mint failed.');
      }

      setPanelSuccess(
        `Mock Community NFT minted! Origin: ${payload.nft.origin} (mintStatus: ${payload.nft.mintStatus}, community: ${payload.community?.status ?? 'UPDATED'}).`
      );
      router.refresh();
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Mock mint failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyExistingTx(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setPanelError(null);
    setPanelSuccess(null);

    try {
      const vout = Number.parseInt(voutInput, 10);
      if (!Number.isInteger(vout) || vout < 0) {
        throw new Error('vout must be a non-negative integer.');
      }

      const res = await fetch(`/api/communities/${slug}/nft/confirm-mint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'verify-tx',
          txid: txidInput.trim().toLowerCase(),
          vout,
        }),
      });
      const payload = (await res.json()) as ConfirmMintApiResponse;
      if (!res.ok || !payload.nft) {
        throw new Error(payload.message ?? 'Transaction verification failed.');
      }

      setPanelSuccess(
        `Verified on-chain Community NFT! Origin: ${payload.nft.origin} (mintStatus: ${payload.nft.mintStatus}, confirmation: ${payload.nft.confirmationStatus}).`
      );
      router.refresh();
    } catch (err) {
      setPanelError(
        err instanceof Error ? err.message : 'Transaction verification failed.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Community NFT Minting &amp; Verification
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Status: <span className="font-mono text-amber-300">{communityStatus}</span>{' '}
            | Mode: <span className="font-mono text-slate-200">{appMode}</span>{' '}
            | Network:{' '}
            <span className="font-mono text-sky-300">{bsvNetwork}net</span>
          </p>
        </div>

        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300">
          On-chain locking script controls ownership
        </span>
      </div>

      {/* Active Wallet Status Bar */}
      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-slate-300">
              Active Wallet:{' '}
              <span className="font-semibold uppercase text-white">
                {activeProviderLabel}
              </span>{' '}
              <span className="text-slate-500">({connectionState})</span>
            </p>
            <p className="font-mono text-[11px] text-slate-400">
              Verified Payout Script:{' '}
              {effectiveDestinationScript ? (
                <span className="text-emerald-300">
                  {effectiveDestinationScript}
                </span>
              ) : (
                <span className="text-amber-300">
                  Not yet derived/verified
                </span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(connectionState === 'reauth_required' ||
              (sessionData?.authenticated && !activeAdapter)) && (
              <button
                type="button"
                onClick={() => void reconnectActiveWallet()}
                disabled={submitting}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                Reconnect Wallet
              </button>
            )}

            {activeAdapter &&
              capabilities?.supportsBrc100 &&
              !currentPayoutScript && (
                <button
                  type="button"
                  onClick={() => void deriveVerifiedDestination()}
                  disabled={submitting}
                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  Derive &amp; Verify Destination
                </button>
              )}
          </div>
        </div>

        {capabilities && !capabilities.canMintOrdinal && (
          <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
            Connected provider transport ({capabilities.connectionTransport}) is
            authentication-only and cannot build BRC-100 1Sat Ordinal mint
            transactions. Connect Yours BRC-100 (window.CWI) or HandCash Desktop
            BRC Wallet, or submit an externally minted txid/vout below.
          </p>
        )}
      </div>

      {!isCreator && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          Only the authenticated community creator may initiate or verify the
          initial Community NFT mint.
        </div>
      )}

      {panelError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200"
        >
          {panelError}
        </div>
      )}

      {mintStep && (
        <div className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
          {mintStep}
        </div>
      )}

      {panelSuccess && (
        <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
          {panelSuccess}
        </div>
      )}

      {/* Canonical Metadata Preview */}
      <details className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs">
        <summary className="cursor-pointer font-medium text-slate-300">
          Authoritative 1Sat Ordinal Metadata Payload (SHA-256:{' '}
          <span className="font-mono text-sky-300">
            {contentSha256Hex.slice(0, 16)}...
          </span>
          )
        </summary>
        <pre className="mt-3 overflow-x-auto rounded bg-slate-900 p-3 font-mono text-[11px] text-slate-300">
          {canonicalMetadataJson}
        </pre>
      </details>

      {isCreator && communityStatus !== 'ACTIVE' && (
        <div className="mt-5 space-y-5">
          {/* Live BRC-100 Wallet Mint Section */}
          {appMode === 'live' && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-4">
              <h3 className="text-sm font-semibold text-white">
                Authorize &amp; Mint 1Sat Ordinal via Connected Wallet
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                Builds an authentic 1-satoshi 1Sat Ordinal inscription locked to
                your verified BRC-42 P2PKH destination script via{' '}
                {activeAdapter?.provider === 'handcash'
                  ? 'HandCash BRC-100 createAction'
                  : 'Yours BRC-100 / @1sat/actions'}{' '}
                on {bsvNetwork}net, then independently verifies the output on
                the server.
              </p>

              {bsvNetwork === 'main' && (
                <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                  Mainnet minting is guarded by ALLOW_MAINNET_MINT=true. Switch
                  to BSV_NETWORK=test for live wallet testing.
                </p>
              )}

              <button
                type="button"
                onClick={() => void handleLiveWalletMint()}
                disabled={
                  submitting ||
                  !activeAdapter ||
                  !activeWalletInterface ||
                  !capabilities?.canMintOrdinal
                }
                className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting
                  ? 'Minting...'
                  : 'Authorize & Mint 1Sat Ordinal NFT'}
              </button>
            </div>
          )}

          {/* Mock Mint Section */}
          {appMode === 'mock' && (
            <form
              onSubmit={handleMockMint}
              className="rounded-lg border border-amber-500/30 bg-amber-950/15 p-4"
            >
              <h3 className="text-sm font-semibold text-white">
                Safe Mock Mode Mint
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                Simulates a 1Sat Ordinal mint locally without broadcasting on
                Bitcoin SV. Requires a verified 25-byte P2PKH locking script
                (never derives payout from raw identityKey).
              </p>

              <label className="mt-3 block text-xs font-medium text-slate-300">
                Destination 25-byte P2PKH Locking Script (hex)
                <input
                  type="text"
                  value={manualDestinationScript}
                  onChange={(e) => setManualDestinationScript(e.target.value)}
                  placeholder="76a914...88ac"
                  className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100"
                />
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="mt-3 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {submitting ? 'Minting Mock NFT...' : 'Mint Mock Community NFT'}
              </button>
            </form>
          )}

          {/* Manual External Tx Verification */}
          <form
            onSubmit={handleVerifyExistingTx}
            className="rounded-lg border border-slate-800 bg-slate-950/60 p-4"
          >
            <h3 className="text-sm font-semibold text-white">
              Verify Submitted Transaction (Manual Recovery / External Mint)
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Submit an existing 1Sat Ordinal mint transaction ID and exact
              output index (vout) for independent server-side inscription and
              locking-script verification.
            </p>

            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <label className="block text-xs font-medium text-slate-300 md:col-span-3">
                Transaction ID (txid)
                <input
                  type="text"
                  value={txidInput}
                  onChange={(e) => setTxidInput(e.target.value)}
                  placeholder="64-character lowercase hex txid"
                  className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100"
                />
              </label>

              <label className="block text-xs font-medium text-slate-300">
                Output Index (vout)
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={voutInput}
                  onChange={(e) => setVoutInput(e.target.value)}
                  className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100"
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={submitting || txidInput.trim().length !== 64}
              className="mt-3 rounded-lg border border-sky-500/40 bg-sky-500/15 px-4 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-50"
            >
              {submitting ? 'Verifying Tx...' : 'Verify On-Chain Mint Output'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
