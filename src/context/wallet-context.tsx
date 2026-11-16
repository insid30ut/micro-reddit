'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { WalletInterface } from '@bsv/sdk';
import type { MockPersonaId } from '@/adapters/wallets/mock.adapter';
import {
  createExplicitWalletAdapter,
  discoverAvailableWallets,
  type WalletRegistryEnvironment,
} from '@/adapters/wallets/provider-registry';
import {
  WalletConnectionError,
  type WalletAdapter,
} from '@/adapters/wallets/wallet-adapter';
import type {
  MintOrdinalInput,
  MintResult,
  VerifiedWalletDestination,
  WalletCapabilities,
  WalletConnectionState,
  WalletIdentity,
  WalletProviderDiscovery,
  WalletProviderType,
} from '@/types/wallet';

const SELECTED_PROVIDER_STORAGE_KEY = 'micro_reddit_selected_wallet_provider';
const MOCK_PERSONA_STORAGE_KEY = 'micro_reddit_mock_persona';

export interface SessionWalletInfo {
  id: string;
  provider: WalletProviderType;
  identityKey: string;
  publicKey: string;
  payoutScript: string | null;
  network: 'main' | 'test';
  connected: boolean;
  lastVerifiedAt: string;
}

export interface SessionApiResponse {
  authenticated: boolean;
  user: {
    id: string;
    displayName: string | null;
  } | null;
  activeWallet: SessionWalletInfo | null;
  wallets: SessionWalletInfo[];
  session?: {
    sessionId: string;
    issuedAt: string;
    expiresAt: string;
  } | null;
}

export interface AppWalletContextValue {
  appMode: 'mock' | 'live';
  bsvNetwork: 'main' | 'test';
  selectedProvider: WalletProviderType | null;
  connectionState: WalletConnectionState;
  identity: WalletIdentity | null;
  network: 'main' | 'test';
  activeAdapter: WalletAdapter | null;
  activeWalletInterface: WalletInterface | null;
  capabilities: WalletCapabilities | null;
  verifiedDestination: VerifiedWalletDestination | null;
  currentPayoutScript: string | null;
  discoveredProviders: WalletProviderDiscovery[];
  sessionData: SessionApiResponse | null;
  mockPersona: MockPersonaId;
  setMockPersona: (persona: MockPersonaId) => void;
  errorMessage: string | null;
  statusMessage: string | null;
  busyAction: string | null;
  syncRuntimeConfig: (config: {
    appMode?: 'mock' | 'live';
    bsvNetwork?: 'main' | 'test';
  }) => void;
  refreshDiscovery: () => Promise<WalletProviderDiscovery[]>;
  refreshSession: () => Promise<SessionApiResponse | null>;
  connectAndAuthenticate: (
    provider: WalletProviderType,
    options?: { persona?: MockPersonaId }
  ) => Promise<void>;
  reconnectActiveWallet: () => Promise<void>;
  deriveVerifiedDestination: (options?: {
    keyID?: string;
  }) => Promise<VerifiedWalletDestination>;
  mintCommunityOrdinal: (input: MintOrdinalInput) => Promise<MintResult>;
  disconnectWallet: (walletId?: string) => Promise<void>;
  logout: () => Promise<void>;
  clearMessages: () => void;
}

const AppWalletContext = createContext<AppWalletContextValue | null>(null);

function isWalletProviderType(value: unknown): value is WalletProviderType {
  return value === 'yours' || value === 'handcash' || value === 'mock';
}

function isMockPersonaId(value: unknown): value is MockPersonaId {
  return value === 'alice' || value === 'bob' || value === 'payer';
}

function readSessionStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (value === null) {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage restrictions in privacy-hardened browsers.
  }
}

function buildRegistryEnv(config: {
  appMode: 'mock' | 'live';
  bsvNetwork: 'main' | 'test';
  mockPersona: MockPersonaId;
  allowMainnetBroadcast?: boolean;
}): WalletRegistryEnvironment {
  const allowMainnetMint = config.allowMainnetBroadcast === true;
  return {
    appMode: config.appMode,
    yoursOptions: {
      appMode: config.appMode,
      expectedNetwork: config.bsvNetwork,
      allowMainnetMint,
    },
    handcashOptions: {
      appMode: config.appMode,
      expectedNetwork: config.bsvNetwork,
      allowMainnetMint,
    },
    mockOptions: {
      persona: config.mockPersona,
      network: config.bsvNetwork,
    },
  };
}

function formatWalletError(err: unknown): string {
  if (err instanceof WalletConnectionError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Unexpected wallet operation error.';
}

export interface AppWalletProviderProps {
  children: React.ReactNode;
  appMode?: 'mock' | 'live';
  bsvNetwork?: 'main' | 'test';
  /** Server-approved mainnet broadcasting (APP_MODE=live, BSV_NETWORK=main, ALLOW_MAINNET_BROADCAST=true) */
  allowMainnetBroadcast?: boolean;
}

export function AppWalletProvider({
  children,
  appMode: initialAppMode = 'mock',
  bsvNetwork: initialBsvNetwork = 'test',
  allowMainnetBroadcast = false,
}: AppWalletProviderProps) {
  const [appMode, setAppMode] = useState<'mock' | 'live'>(initialAppMode);
  const [bsvNetwork, setBsvNetwork] = useState<'main' | 'test'>(
    initialBsvNetwork
  );
  const [selectedProvider, setSelectedProvider] =
    useState<WalletProviderType | null>(() => {
      const saved = readSessionStorage(SELECTED_PROVIDER_STORAGE_KEY);
      return isWalletProviderType(saved) ? saved : null;
    });
  const [mockPersona, setMockPersonaState] = useState<MockPersonaId>(() => {
    const saved = readSessionStorage(MOCK_PERSONA_STORAGE_KEY);
    return isMockPersonaId(saved) ? saved : 'alice';
  });

  const [connectionState, setConnectionState] =
    useState<WalletConnectionState>('disconnected');
  const [identity, setIdentity] = useState<WalletIdentity | null>(null);
  const [network, setNetwork] = useState<'main' | 'test'>(initialBsvNetwork);
  const [activeAdapter, setActiveAdapter] = useState<WalletAdapter | null>(
    null
  );
  const [activeWalletInterface, setActiveWalletInterface] =
    useState<WalletInterface | null>(null);
  const [capabilities, setCapabilities] = useState<WalletCapabilities | null>(
    null
  );
  const [verifiedDestination, setVerifiedDestination] =
    useState<VerifiedWalletDestination | null>(null);
  const [discoveredProviders, setDiscoveredProviders] = useState<
    WalletProviderDiscovery[]
  >([]);
  const [sessionData, setSessionData] = useState<SessionApiResponse | null>(
    null
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const activeAdapterRef = useRef<WalletAdapter | null>(null);
  const runtimeRef = useRef({
    appMode,
    bsvNetwork,
    mockPersona,
    allowMainnetBroadcast,
  });
  runtimeRef.current = { appMode, bsvNetwork, mockPersona, allowMainnetBroadcast };

  const initializedRef = useRef(false);

  const setMockPersona = useCallback((persona: MockPersonaId) => {
    setMockPersonaState(persona);
    writeSessionStorage(MOCK_PERSONA_STORAGE_KEY, persona);
  }, []);

  const syncRuntimeConfig = useCallback(
    (config: { appMode?: 'mock' | 'live'; bsvNetwork?: 'main' | 'test' }) => {
      if (config.appMode) {
        setAppMode((prev) => (prev === config.appMode ? prev : config.appMode!));
      }
      if (config.bsvNetwork) {
        setBsvNetwork((prev) =>
          prev === config.bsvNetwork ? prev : config.bsvNetwork!
        );
      }
    },
    []
  );

  const clearMessages = useCallback(() => {
    setErrorMessage(null);
    setStatusMessage(null);
  }, []);

  const refreshDiscovery = useCallback(async () => {
    try {
      const env = buildRegistryEnv(runtimeRef.current);
      const list = await discoverAvailableWallets(env);
      setDiscoveredProviders(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/session', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as SessionApiResponse;
      setSessionData(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  const attemptWalletRehydrate = useCallback(
    async (session: SessionApiResponse): Promise<void> => {
      const sessionWallet = session.activeWallet;
      if (!session.authenticated || !sessionWallet) {
        activeAdapterRef.current = null;
        setActiveAdapter(null);
        setActiveWalletInterface(null);
        setIdentity(null);
        setCapabilities(null);
        setVerifiedDestination(null);
        setConnectionState('disconnected');
        return;
      }

      const provider = sessionWallet.provider;
      setSelectedProvider(provider);
      writeSessionStorage(SELECTED_PROVIDER_STORAGE_KEY, provider);
      setNetwork(sessionWallet.network);

      if (provider === 'mock' && runtimeRef.current.appMode === 'live') {
        setConnectionState('reauth_required');
        setStatusMessage(
          'Session uses mock wallet while appMode is live. Connect a live BRC-100 wallet.'
        );
        return;
      }

      setConnectionState('reconnecting');

      try {
        const adapter = createExplicitWalletAdapter(
          provider,
          buildRegistryEnv(runtimeRef.current)
        );
        const available = await adapter.isAvailable();
        if (!available) {
          activeAdapterRef.current = null;
          setActiveAdapter(null);
          setActiveWalletInterface(null);
          setCapabilities(adapter.getCapabilities());
          setConnectionState('reauth_required');
          setStatusMessage(
            `Server session is active for ${provider}, but no live wallet interface was detected. Ensure the wallet is running/unlocked and click Reconnect.`
          );
          return;
        }

        const conn = await adapter.connect();
        if (conn.identityKey !== sessionWallet.identityKey) {
          activeAdapterRef.current = null;
          setActiveAdapter(null);
          setActiveWalletInterface(null);
          setCapabilities(adapter.getCapabilities());
          setConnectionState('reauth_required');
          setErrorMessage(
            `Active ${provider} wallet identity (${conn.identityKey.slice(0, 12)}...) differs from the authenticated session wallet (${sessionWallet.identityKey.slice(0, 12)}...). Switch accounts in your wallet or re-authenticate.`
          );
          return;
        }

        const resolvedCapabilities =
          conn.capabilities ?? adapter.getCapabilities();
        activeAdapterRef.current = adapter;
        setActiveAdapter(adapter);
        setActiveWalletInterface(adapter.getWalletInterface());
        setCapabilities(resolvedCapabilities);
        setIdentity({
          provider: conn.provider,
          identityKey: conn.identityKey,
          publicKey: conn.publicKey,
          network: conn.network,
          ...(conn.payoutScript
            ? { payoutScript: conn.payoutScript }
            : sessionWallet.payoutScript
              ? { payoutScript: sessionWallet.payoutScript }
              : {}),
          ...(conn.destinationProof
            ? { destinationProof: conn.destinationProof }
            : {}),
          capabilities: resolvedCapabilities,
          ...(conn.displayName ? { displayName: conn.displayName } : {}),
          ...(conn.version ? { version: conn.version } : {}),
        });
        if (conn.destinationProof) {
          setVerifiedDestination(conn.destinationProof);
        }
        setNetwork(conn.network);
        setConnectionState('authenticated');
        setStatusMessage(
          `Reconnected ${provider} wallet (${conn.identityKey.slice(0, 12)}...).`
        );
      } catch (err) {
        activeAdapterRef.current = null;
        setActiveAdapter(null);
        setActiveWalletInterface(null);
        setConnectionState('reauth_required');
        setStatusMessage(
          `Server session restored, but live ${provider} adapter requires reconnection: ${formatWalletError(err)}`
        );
      }
    },
    []
  );

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    let cancelled = false;
    void (async () => {
      await refreshDiscovery();
      const session = await refreshSession();
      if (!cancelled && session) {
        await attemptWalletRehydrate(session);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attemptWalletRehydrate, refreshDiscovery, refreshSession]);

  // Re-run discovery when runtime configuration changes (e.g. server props sync)
  useEffect(() => {
    void refreshDiscovery();
  }, [appMode, bsvNetwork, refreshDiscovery]);

  const connectAndAuthenticate = useCallback(
    async (
      provider: WalletProviderType,
      options?: { persona?: MockPersonaId }
    ) => {
      const effectivePersona = options?.persona ?? runtimeRef.current.mockPersona;
      if (options?.persona) {
        setMockPersona(options.persona);
      }

      setBusyAction(`connect:${provider}`);
      setErrorMessage(null);
      setStatusMessage(null);
      setSelectedProvider(provider);
      writeSessionStorage(SELECTED_PROVIDER_STORAGE_KEY, provider);
      setConnectionState('connecting');

      try {
        const adapter = createExplicitWalletAdapter(
          provider,
          buildRegistryEnv({
            appMode: runtimeRef.current.appMode,
            bsvNetwork: runtimeRef.current.bsvNetwork,
            mockPersona: effectivePersona,
            allowMainnetBroadcast: runtimeRef.current.allowMainnetBroadcast,
          })
        );

        const available = await adapter.isAvailable();
        if (!available) {
          throw new WalletConnectionError(
            provider,
            'WALLET_NOT_FOUND',
            provider === 'yours'
              ? 'Yours Wallet was not detected in this browser. Install/unlock the Yours extension and refresh.'
              : provider === 'handcash'
                ? 'HandCash BRC-100 Desktop bridge was not detected at https://127.0.0.1:2121 or http://127.0.0.1:3321. Start and unlock HandCash Desktop Wallet.'
                : 'Mock wallet is unavailable in current mode.'
          );
        }

        const connection = await adapter.connect();
        setConnectionState('authenticating');

        const challengeResponse = await fetch('/api/auth/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider }),
        });
        const challengePayload = (await challengeResponse.json()) as {
          challengeId?: string;
          challengeText?: string;
          message?: string;
        };

        if (
          !challengeResponse.ok ||
          !challengePayload.challengeId ||
          !challengePayload.challengeText
        ) {
          throw new Error(
            challengePayload.message ??
              'Failed to issue server authentication challenge.'
          );
        }

        const signatureResult = await adapter.signChallenge(
          challengePayload.challengeText
        );
        const postSignIdentity = await adapter.getIdentity();

        const verifyResponse = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            challengeId: challengePayload.challengeId,
            provider,
            publicKey: signatureResult.publicKey,
            identityKey: postSignIdentity.identityKey,
            signature: signatureResult.signature,
            ...(signatureResult.keyID ? { keyID: signatureResult.keyID } : {}),
            ...(signatureResult.signatureScheme
              ? { signatureScheme: signatureResult.signatureScheme }
              : {}),
            ...(connection.payoutScript && connection.destinationProof
              ? {
                  payoutScript: connection.payoutScript,
                  destinationProof: connection.destinationProof,
                }
              : {}),
            network: connection.network,
            ...(connection.displayName
              ? { displayName: connection.displayName }
              : {}),
          }),
        });

        const verifyPayload = (await verifyResponse.json()) as {
          authenticated?: boolean;
          message?: string;
          activeWallet?: SessionWalletInfo;
        };

        if (!verifyResponse.ok || !verifyPayload.authenticated) {
          throw new Error(
            verifyPayload.message ??
              'Server wallet signature verification failed.'
          );
        }

        const resolvedCapabilities =
          connection.capabilities ?? adapter.getCapabilities();
        activeAdapterRef.current = adapter;
        setActiveAdapter(adapter);
        setActiveWalletInterface(adapter.getWalletInterface());
        setCapabilities(resolvedCapabilities);
        setNetwork(connection.network);
        setIdentity({
          provider: connection.provider,
          identityKey: postSignIdentity.identityKey,
          publicKey: postSignIdentity.publicKey,
          network: connection.network,
          ...(verifyPayload.activeWallet?.payoutScript
            ? { payoutScript: verifyPayload.activeWallet.payoutScript }
            : connection.payoutScript
              ? { payoutScript: connection.payoutScript }
              : {}),
          ...(connection.destinationProof
            ? { destinationProof: connection.destinationProof }
            : {}),
          capabilities: resolvedCapabilities,
          ...(connection.displayName
            ? { displayName: connection.displayName }
            : {}),
          ...(connection.version ? { version: connection.version } : {}),
        });
        setVerifiedDestination(connection.destinationProof ?? null);
        setConnectionState('authenticated');

        await Promise.all([refreshSession(), refreshDiscovery()]);
        setStatusMessage(
          `Authenticated via ${provider} wallet (${postSignIdentity.identityKey.slice(0, 12)}...).`
        );
      } catch (err) {
        activeAdapterRef.current = null;
        setActiveAdapter(null);
        setActiveWalletInterface(null);
        setConnectionState('error');
        setErrorMessage(formatWalletError(err));
      } finally {
        setBusyAction(null);
      }
    },
    [refreshDiscovery, refreshSession, setMockPersona]
  );

  const reconnectActiveWallet = useCallback(async () => {
    const provider =
      sessionData?.activeWallet?.provider ?? selectedProvider ?? null;
    if (!provider) {
      setErrorMessage(
        'No wallet provider selected to reconnect. Choose Yours Wallet (or Mock Wallet in mock mode) below.'
      );
      return;
    }

    if (sessionData?.authenticated && sessionData.activeWallet) {
      setBusyAction('reconnect');
      setErrorMessage(null);
      await attemptWalletRehydrate(sessionData);
      await refreshDiscovery();
      setBusyAction(null);
      return;
    }

    await connectAndAuthenticate(provider);
  }, [
    attemptWalletRehydrate,
    connectAndAuthenticate,
    refreshDiscovery,
    selectedProvider,
    sessionData,
  ]);

  const deriveVerifiedDestination = useCallback(
    async (options?: {
      keyID?: string;
    }): Promise<VerifiedWalletDestination> => {
      const adapter = activeAdapterRef.current;
      if (!adapter) {
        throw new WalletConnectionError(
          selectedProvider ?? 'yours',
          'WALLET_LOCKED',
          'Active wallet interface is not connected in this browser tab. Reconnect your wallet before deriving a payment destination.'
        );
      }

      setBusyAction('derive-destination');
      setErrorMessage(null);
      try {
        const proof = await adapter.deriveDestination(options);

        const response = await fetch('/api/wallets/destination', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            provider: adapter.provider,
            destinationProof: proof,
          }),
        });

        const payload = (await response.json()) as {
          verified?: boolean;
          currentPayoutScript?: string;
          message?: string;
        };

        if (!response.ok || !payload.verified || !payload.currentPayoutScript) {
          throw new Error(
            payload.message ??
              'Server failed to verify derived wallet payment destination.'
          );
        }

        setVerifiedDestination(proof);
        setIdentity((prev) =>
          prev
            ? {
                ...prev,
                payoutScript: payload.currentPayoutScript!,
                destinationProof: proof,
              }
            : prev
        );
        await refreshSession();
        setStatusMessage(
          `Verified BRC-42 payout destination (${payload.currentPayoutScript.slice(0, 16)}...).`
        );
        return proof;
      } catch (err) {
        const message = formatWalletError(err);
        setErrorMessage(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setBusyAction(null);
      }
    },
    [refreshSession, selectedProvider]
  );

  const mintCommunityOrdinal = useCallback(
    async (input: MintOrdinalInput): Promise<MintResult> => {
      const adapter = activeAdapterRef.current;
      if (!adapter) {
        throw new WalletConnectionError(
          selectedProvider ?? 'yours',
          'WALLET_LOCKED',
          'No active wallet connection in browser state. Reconnect your wallet before authorizing a 1Sat Ordinal mint.'
        );
      }

      const caps = adapter.getCapabilities();
      if (!caps.canMintOrdinal) {
        throw new WalletConnectionError(
          adapter.provider,
          'UNSUPPORTED_OPERATION',
          adapter.provider === 'yours'
            ? 'Yours Wallet is currently connected via legacy window.yours (authentication-only). Enable Yours BRC-100 (window.CWI) or reconnect with BRC-100 to mint 1Sat Ordinals.'
            : `Wallet provider "${adapter.provider}" does not support 1Sat Ordinal minting.`
        );
      }

      setBusyAction('mint');
      setErrorMessage(null);
      try {
        return await adapter.mintOrdinal(input);
      } catch (err) {
        const message = formatWalletError(err);
        setErrorMessage(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setBusyAction(null);
      }
    },
    [selectedProvider]
  );

  const disconnectWallet = useCallback(
    async (walletId?: string) => {
      setBusyAction(`disconnect:${walletId ?? 'active'}`);
      setErrorMessage(null);
      try {
        const adapter = activeAdapterRef.current;
        const disconnectingActive =
          !walletId || sessionData?.activeWallet?.id === walletId;
        if (adapter && disconnectingActive) {
          try {
            await adapter.disconnect();
          } catch {
            // Continue clearing server connection record cleanly.
          }
        }

        const response = await fetch('/api/wallets/disconnect', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(
            walletId ? { walletConnectionId: walletId } : {}
          ),
        });
        const payload = (await response.json()) as { message?: string };
        if (!response.ok) {
          throw new Error(payload.message ?? 'Failed to disconnect wallet.');
        }

        const updatedSession = await refreshSession();
        if (!updatedSession?.authenticated) {
          activeAdapterRef.current = null;
          setActiveAdapter(null);
          setActiveWalletInterface(null);
          setIdentity(null);
          setCapabilities(null);
          setVerifiedDestination(null);
          setSelectedProvider(null);
          writeSessionStorage(SELECTED_PROVIDER_STORAGE_KEY, null);
          setConnectionState('disconnected');
        } else if (disconnectingActive) {
          await attemptWalletRehydrate(updatedSession);
        }
        await refreshDiscovery();
        setStatusMessage('Wallet disconnected.');
      } catch (err) {
        setErrorMessage(formatWalletError(err));
      } finally {
        setBusyAction(null);
      }
    },
    [
      attemptWalletRehydrate,
      refreshDiscovery,
      refreshSession,
      sessionData?.activeWallet?.id,
    ]
  );

  const logout = useCallback(async () => {
    setBusyAction('logout');
    setErrorMessage(null);
    try {
      const adapter = activeAdapterRef.current;
      if (adapter) {
        try {
          await adapter.disconnect();
        } catch {
          // Best-effort wallet adapter cleanup.
        }
      }
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      activeAdapterRef.current = null;
      setActiveAdapter(null);
      setActiveWalletInterface(null);
      setIdentity(null);
      setCapabilities(null);
      setVerifiedDestination(null);
      setSessionData({ authenticated: false, user: null, activeWallet: null, wallets: [] });
      setSelectedProvider(null);
      writeSessionStorage(SELECTED_PROVIDER_STORAGE_KEY, null);
      writeSessionStorage(MOCK_PERSONA_STORAGE_KEY, null);
      setConnectionState('disconnected');
      setStatusMessage('Logged out of wallet session.');
      await refreshDiscovery();
    } catch (err) {
      setErrorMessage(formatWalletError(err));
    } finally {
      setBusyAction(null);
    }
  }, [refreshDiscovery]);

  const currentPayoutScript = useMemo(() => {
    return (
      verifiedDestination?.lockingScript ??
      identity?.payoutScript ??
      sessionData?.activeWallet?.payoutScript ??
      null
    );
  }, [
    identity?.payoutScript,
    sessionData?.activeWallet?.payoutScript,
    verifiedDestination?.lockingScript,
  ]);

  const value = useMemo<AppWalletContextValue>(
    () => ({
      appMode,
      bsvNetwork,
      selectedProvider,
      connectionState,
      identity,
      network,
      activeAdapter,
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
      refreshSession,
      connectAndAuthenticate,
      reconnectActiveWallet,
      deriveVerifiedDestination,
      mintCommunityOrdinal,
      disconnectWallet,
      logout,
      clearMessages,
    }),
    [
      activeAdapter,
      activeWalletInterface,
      appMode,
      bsvNetwork,
      busyAction,
      capabilities,
      clearMessages,
      connectAndAuthenticate,
      connectionState,
      currentPayoutScript,
      deriveVerifiedDestination,
      disconnectWallet,
      discoveredProviders,
      errorMessage,
      identity,
      logout,
      mintCommunityOrdinal,
      mockPersona,
      network,
      reconnectActiveWallet,
      refreshDiscovery,
      refreshSession,
      selectedProvider,
      sessionData,
      setMockPersona,
      statusMessage,
      syncRuntimeConfig,
      verifiedDestination,
    ]
  );

  return (
    <AppWalletContext.Provider value={value}>
      {children}
    </AppWalletContext.Provider>
  );
}

export function useAppWallet(): AppWalletContextValue {
  const ctx = useContext(AppWalletContext);
  if (!ctx) {
    throw new Error('useAppWallet must be used inside an <AppWalletProvider>.');
  }
  return ctx;
}
