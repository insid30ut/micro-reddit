'use client';

import React, { useEffect } from 'react';
import type { MockPersonaId } from '@/adapters/wallets/mock.adapter';
import { useAppWallet } from '@/context/wallet-context';
import type { WalletProviderDiscovery } from '@/types/wallet';

export interface WalletConnectPanelProps {
  appMode: 'mock' | 'live';
  bsvNetwork?: 'main' | 'test';
}

function getDiscoveryFor(
  providers: WalletProviderDiscovery[],
  provider: 'yours' | 'handcash' | 'mock'
): WalletProviderDiscovery | undefined {
  return providers.find((item) => item.provider === provider);
}

function StateBadge({ state }: { state: string }) {
  const styles =
    state === 'authenticated' || state === 'connected'
      ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
      : state === 'reauth_required' || state === 'error'
        ? 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
        : state === 'connecting' ||
            state === 'authenticating' ||
            state === 'reconnecting'
          ? 'bg-sky-500/15 text-sky-300 ring-sky-500/30'
          : 'bg-slate-800 text-slate-300 ring-slate-700';

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles}`}
    >
      {state}
    </span>
  );
}

export function WalletConnectPanel({
  appMode,
  bsvNetwork,
}: WalletConnectPanelProps) {
  const {
    selectedProvider,
    connectionState,
    identity,
    activeWalletInterface,
    capabilities,
    verifiedDestination,
    currentPayoutScript,
    discoveredProviders,
    sessionData,
    mockPersona,
    setMockPersona,
    errorMessage,
    statusMessage,
    busyAction,
    syncRuntimeConfig,
    refreshDiscovery,
    connectAndAuthenticate,
    reconnectActiveWallet,
    deriveVerifiedDestination,
    disconnectWallet,
    logout,
  } = useAppWallet();

  useEffect(() => {
    syncRuntimeConfig({
      appMode,
      ...(bsvNetwork ? { bsvNetwork } : {}),
    });
  }, [appMode, bsvNetwork, syncRuntimeConfig]);

  const yoursInfo = getDiscoveryFor(discoveredProviders, 'yours');
  const mockInfo = getDiscoveryFor(discoveredProviders, 'mock');
  const isAuthenticated = Boolean(sessionData?.authenticated);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-white">
              BRC-100 Wallet Authentication &amp; Identity
            </h2>
            <StateBadge state={connectionState} />
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Explicit provider selection only (never auto-races multiple
            wallets). Private keys remain strictly inside your wallet.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshDiscovery()}
            disabled={busyAction !== null}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            Re-scan Wallets
          </button>
          {isAuthenticated && (
            <button
              type="button"
              onClick={() => void logout()}
              disabled={busyAction !== null}
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
            >
              Logout
            </button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200"
        >
          {errorMessage}
        </div>
      )}

      {statusMessage && (
        <div className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
          {statusMessage}
        </div>
      )}

      {connectionState === 'reauth_required' && sessionData?.activeWallet && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <div>
            <p className="font-semibold text-amber-100">
              Wallet interface needs reconnection
            </p>
            <p className="mt-0.5 text-amber-200/90">
              Your session is authenticated as{' '}
              <span className="font-mono">
                {sessionData.activeWallet.provider}
              </span>{' '}
              ({sessionData.activeWallet.identityKey.slice(0, 14)}...), but the
              live wallet bridge/extension is locked or disconnected in this
              browser tab.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void reconnectActiveWallet()}
            disabled={busyAction !== null}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {busyAction === 'reconnect'
              ? 'Reconnecting...'
              : 'Reconnect Wallet'}
          </button>
        </div>
      )}

      <div
        className={`mt-5 grid gap-4 ${
          appMode === 'mock' ? 'md:grid-cols-2' : 'md:grid-cols-1'
        }`}
      >
        {/* Yours Wallet Card */}
        <div className="flex flex-col justify-between rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-white">Yours Wallet</h3>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  yoursInfo?.available
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {yoursInfo?.available ? yoursInfo.transport : 'Not detected'}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              {yoursInfo?.details ??
                'Uses BRC-100 window.CWI for challenge auth & 1Sat Ordinal minting (legacy window.yours fallback is auth-only).'}
            </p>
          </div>

          <button
            type="button"
            onClick={() => void connectAndAuthenticate('yours')}
            disabled={busyAction !== null}
            className={`mt-4 w-full rounded-lg px-3 py-2 text-xs font-semibold transition ${
              selectedProvider === 'yours' && isAuthenticated
                ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            } disabled:opacity-50`}
          >
            {busyAction === 'connect:yours'
              ? 'Connecting Yours...'
              : isAuthenticated
                ? 'Connect / Link Yours Wallet'
                : 'Connect Yours Wallet'}
          </button>
        </div>

        {/* Mock Wallet Card (only in mock mode) */}
        {appMode === 'mock' && (
          <div className="flex flex-col justify-between rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <div>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white">
                  Mock Wallet
                </h3>
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                  {mockInfo?.transport ?? 'mock'}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Offline deterministic @bsv/sdk ProtoWallet for testing flows
                without broadcasting real BSV transactions.
              </p>

              <label className="mt-3 block text-[11px] font-medium text-slate-300">
                Test Persona
                <select
                  value={mockPersona}
                  onChange={(e) =>
                    setMockPersona(e.target.value as MockPersonaId)
                  }
                  disabled={busyAction !== null}
                  className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="alice">Alice (Mock Creator)</option>
                  <option value="bob">Bob (Mock Recipient)</option>
                  <option value="payer">Charlie (Mock Payer)</option>
                </select>
              </label>
            </div>

            <button
              type="button"
              onClick={() =>
                void connectAndAuthenticate('mock', { persona: mockPersona })
              }
              disabled={busyAction !== null}
              className="mt-4 w-full rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
            >
              {busyAction === 'connect:mock'
                ? 'Signing Mock Challenge...'
                : isAuthenticated
                  ? 'Switch / Link Mock Wallet'
                  : 'Connect Mock Wallet'}
            </button>
          </div>
        )}
      </div>

      {/* Authenticated Session & Active Wallet Status */}
      {isAuthenticated && sessionData?.activeWallet && (
        <div className="mt-6 space-y-4 rounded-lg border border-slate-800 bg-slate-950/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Active Authenticated Session
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">
                User:{' '}
                <span className="font-mono text-slate-200">
                  {sessionData.user?.displayName ?? sessionData.user?.id}
                </span>{' '}
                | Provider:{' '}
                <span className="font-mono text-emerald-300">
                  {sessionData.activeWallet.provider}
                </span>{' '}
                | Network:{' '}
                <span className="font-mono text-sky-300">
                  {identity?.network ?? sessionData.activeWallet.network}
                </span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {capabilities && (
                <>
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                    {capabilities.connectionTransport}
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] ${
                      capabilities.canMintOrdinal
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {capabilities.canMintOrdinal
                      ? 'Minting: Enabled'
                      : 'Auth-Only (No BRC-100 Mint)'}
                  </span>
                </>
              )}
              <span
                className={`rounded px-2 py-0.5 text-[11px] ${
                  activeWalletInterface ||
                  sessionData.activeWallet.provider === 'mock'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {activeWalletInterface
                  ? 'Live WalletInterface Ready'
                  : sessionData.activeWallet.provider === 'mock'
                    ? 'Mock Adapter Ready'
                    : 'Reconnect for Signing'}
              </span>
            </div>
          </div>

          <dl className="grid gap-3 text-xs md:grid-cols-2">
            <div>
              <dt className="text-slate-400">Identity Public Key</dt>
              <dd className="mt-1 break-all font-mono text-slate-200">
                {identity?.identityKey ?? sessionData.activeWallet.identityKey}
              </dd>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-400">
                  Verified BRC-42 Payment Script (Separate from Identity Key)
                </dt>
                <button
                  type="button"
                  onClick={() => void deriveVerifiedDestination()}
                  disabled={
                    busyAction !== null ||
                    (!activeWalletInterface &&
                      sessionData.activeWallet.provider !== 'mock')
                  }
                  className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  {busyAction === 'derive-destination'
                    ? 'Verifying...'
                    : currentPayoutScript
                      ? 'Re-verify Destination'
                      : 'Derive & Verify Destination'}
                </button>
              </div>
              <dd className="mt-1 break-all font-mono text-slate-200">
                {currentPayoutScript ? (
                  <span>{currentPayoutScript}</span>
                ) : (
                  <span className="text-amber-300">
                    Not yet verified — click Derive &amp; Verify Destination
                    before live minting.
                  </span>
                )}
              </dd>
              {verifiedDestination?.address && (
                <p className="mt-1 font-mono text-[11px] text-slate-400">
                  Address: {verifiedDestination.address}
                </p>
              )}
            </div>
          </dl>

          {sessionData.wallets.length > 0 && (
            <div className="border-t border-slate-800 pt-3">
              <p className="text-xs font-medium text-slate-300">
                Linked Wallets ({sessionData.wallets.length})
              </p>
              <ul className="mt-2 space-y-2">
                {sessionData.wallets.map((w) => (
                  <li
                    key={w.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <span className="font-semibold uppercase text-slate-200">
                        {w.provider}
                      </span>{' '}
                      <span className="font-mono text-slate-400">
                        {w.identityKey.slice(0, 16)}...
                      </span>{' '}
                      <span className="text-slate-500">({w.network})</span>
                      {w.payoutScript ? (
                        <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          Destination Verified
                        </span>
                      ) : (
                        <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                          No Destination Script
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void disconnectWallet(w.id)}
                      disabled={busyAction !== null}
                      className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Disconnect
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
