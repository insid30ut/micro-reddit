'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  WalletConnectionState,
  WalletProviderDiscovery,
  WalletProviderType,
} from '@/types/wallet';
import {
  createExplicitWalletAdapter,
  discoverAvailableWallets,
} from '@/adapters/wallets/provider-registry';
import type { MockPersonaId } from '@/adapters/wallets/mock.adapter';

interface SessionWalletInfo {
  id: string;
  provider: WalletProviderType;
  identityKey: string;
  publicKey: string;
  payoutScript: string;
  network: 'main' | 'test';
  connected: boolean;
  lastVerifiedAt: string;
}

interface SessionResponse {
  authenticated: boolean;
  user?: {
    id: string;
    displayName: string | null;
  };
  activeWallet?: SessionWalletInfo | null;
  wallets?: SessionWalletInfo[];
  session?: {
    sessionId: string;
    issuedAt: string;
    expiresAt: string;
  };
}

export function WalletConnectPanel({ appMode }: { appMode: 'mock' | 'live' }) {
  const [connectionState, setConnectionState] =
    useState<WalletConnectionState>('disconnected');
  const [selectedProvider, setSelectedProvider] =
    useState<WalletProviderType | null>(null);
  const [discoveredProviders, setDiscoveredProviders] = useState<
    WalletProviderDiscovery[]
  >([]);
  const [sessionData, setSessionData] = useState<SessionResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mockPersona, setMockPersona] = useState<MockPersonaId>('alice');

  useEffect(() => {
    void (async () => {
      const discovered = await discoverAvailableWallets({ appMode });
      setDiscoveredProviders(discovered);
      await fetchCurrentSession();
    })();
  }, [appMode]);

  async function fetchCurrentSession(): Promise<void> {
    try {
      const res = await fetch('/api/auth/session', { method: 'GET' });
      if (res.ok) {
        const data = (await res.json()) as SessionResponse;
        if (data.authenticated) {
          setSessionData(data);
          setConnectionState('authenticated');
          setSelectedProvider(data.activeWallet?.provider ?? null);
          return;
        }
      }
      setSessionData(null);
      setConnectionState('disconnected');
    } catch {
      setSessionData(null);
      setConnectionState('disconnected');
    }
  }

  /**
   * Explicitly connects and authenticates the user-chosen wallet provider.
   * Never auto-selects when multiple wallets are installed.
   */
  async function handleExplicitConnect(provider: WalletProviderType): Promise<void> {
    setErrorMessage(null);
    setSelectedProvider(provider);
    setConnectionState('connecting');

    try {
      const adapter = createExplicitWalletAdapter(provider, {
        appMode,
        mockOptions: {
          persona: mockPersona,
          network: 'test',
        },
      });

      const identity = await adapter.connect();
      setConnectionState('connected');

      // Request domain-bound single-use challenge from server
      setConnectionState('authenticating');
      const challengeRes = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });

      const challengePayload = (await challengeRes.json()) as {
        challengeId?: string;
        challengeText?: string;
        message?: string;
      };

      if (
        !challengeRes.ok ||
        !challengePayload.challengeId ||
        !challengePayload.challengeText
      ) {
        throw new Error(
          challengePayload.message ?? 'Failed to obtain authentication challenge.'
        );
      }

      // Sign challenge with wallet adapter
      const sigResult = await adapter.signChallenge(challengePayload.challengeText);

      // Submit signature for server-side verification and HttpOnly session issuance
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: challengePayload.challengeId,
          provider,
          publicKey: sigResult.publicKey,
          identityKey: identity.identityKey,
          signature: sigResult.signature,
          keyID: sigResult.keyID,
          signatureScheme: sigResult.signatureScheme,
          network: identity.network,
          displayName: identity.displayName,
        }),
      });

      const verifyPayload = (await verifyRes.json()) as SessionResponse & {
        message?: string;
      };

      if (!verifyRes.ok || !verifyPayload.authenticated) {
        throw new Error(
          verifyPayload.message ?? 'Cryptographic signature verification failed.'
        );
      }

      setSessionData(verifyPayload);
      setConnectionState('authenticated');
    } catch (error) {
      setConnectionState('error');
      setErrorMessage(
        error instanceof Error ? error.message : 'Wallet connection failed.'
      );
    }
  }

  async function handleDisconnectWallet(walletConnectionId?: string): Promise<void> {
    setErrorMessage(null);
    try {
      const res = await fetch('/api/wallets/disconnect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          walletConnectionId ? { walletConnectionId } : {}
        ),
      });

      if (res.ok) {
        await fetchCurrentSession();
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to disconnect wallet.'
      );
    }
  }

  async function handleLogout(): Promise<void> {
    setErrorMessage(null);
    await fetch('/api/auth/logout', { method: 'POST' });
    setSessionData(null);
    setSelectedProvider(null);
    setConnectionState('disconnected');
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Screen 1 — Explicit Wallet Authentication
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Explicit provider selection required. Automatic multi-wallet racing is disabled.
          </p>
        </div>
        <span className="rounded-md bg-slate-800 px-3 py-1 font-mono text-xs text-slate-300">
          State: {connectionState.toUpperCase()}
        </span>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-300"
        >
          <span className="font-semibold">Wallet Error:</span> {errorMessage}
        </div>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => void handleExplicitConnect('yours')}
          className="flex flex-col items-start rounded-lg border border-emerald-500/40 bg-emerald-950/20 p-4 text-left transition hover:border-emerald-400 hover:bg-emerald-950/40"
        >
          <span className="text-sm font-semibold text-emerald-300">
            Connect Yours Wallet
          </span>
          <span className="mt-1 text-xs text-slate-400">
            Explicit Yours BRC-100 / Extension Auth
          </span>
        </button>

        <button
          type="button"
          onClick={() => void handleExplicitConnect('handcash')}
          className="flex flex-col items-start rounded-lg border border-sky-500/40 bg-sky-950/20 p-4 text-left transition hover:border-sky-400 hover:bg-sky-950/40"
        >
          <span className="text-sm font-semibold text-sky-300">
            Connect HandCash
          </span>
          <span className="mt-1 text-xs text-slate-400">
            Explicit HandCash BRC-100 Substrate Auth
          </span>
        </button>

        {appMode === 'mock' && (
          <div className="flex flex-col justify-between rounded-lg border border-amber-500/40 bg-amber-950/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-amber-300">
                Connect Mock Wallet
              </span>
              <select
                aria-label="Select mock persona"
                value={mockPersona}
                onChange={(e) =>
                  setMockPersona(e.target.value as MockPersonaId)
                }
                className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-200"
              >
                <option value="alice">Alice</option>
                <option value="bob">Bob</option>
                <option value="payer">Charlie (Payer)</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => void handleExplicitConnect('mock')}
              className="mt-2 w-full rounded bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/30"
            >
              Authenticate Mock ({mockPersona.toUpperCase()})
            </button>
          </div>
        )}
      </div>

      {discoveredProviders.length > 0 && (
        <div className="mt-4 text-xs text-slate-400">
          <span className="font-medium text-slate-300">Discovered substrates: </span>
          {discoveredProviders.map((d) => (
            <span key={d.provider} className="mr-3 inline-block font-mono">
              {d.provider}={d.available ? 'ready' : 'not-detected'} ({d.transport})
            </span>
          ))}
        </div>
      )}

      {sessionData?.authenticated && sessionData.activeWallet && (
        <div className="mt-6 space-y-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-emerald-400">
                Authenticated Session Active
              </p>
              <p className="mt-0.5 text-sm font-medium text-white">
                User: {sessionData.user?.displayName ?? sessionData.user?.id}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/dashboard"
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
              >
                Open Dashboard
              </Link>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
              >
                Logout Session
              </button>
            </div>
          </div>

          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-slate-400">Active Provider</dt>
              <dd className="font-mono text-white">
                {sessionData.activeWallet.provider} ({selectedProvider})
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Identity Public Key</dt>
              <dd className="truncate font-mono text-slate-200">
                {sessionData.activeWallet.identityKey}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-400">Derived P2PKH Revenue Script</dt>
              <dd className="truncate font-mono text-emerald-400">
                {sessionData.activeWallet.payoutScript}
              </dd>
            </div>
          </dl>

          {sessionData.wallets && sessionData.wallets.length > 0 && (
            <div className="border-t border-slate-800 pt-3">
              <p className="text-xs font-semibold text-slate-300">
                Linked Wallets ({sessionData.wallets.length}) — click any provider button above to link an additional wallet:
              </p>
              <ul className="mt-2 space-y-1.5 text-xs">
                {sessionData.wallets.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between rounded bg-slate-900 px-3 py-1.5"
                  >
                    <span className="font-mono text-slate-300">
                      [{w.provider}] {w.identityKey.slice(0, 14)}...{' '}
                      {w.connected ? '(connected)' : '(disconnected)'}
                    </span>
                    {w.connected && (
                      <button
                        type="button"
                        onClick={() => void handleDisconnectWallet(w.id)}
                        className="text-rose-400 hover:text-rose-300"
                      >
                        Disconnect
                      </button>
                    )}
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
