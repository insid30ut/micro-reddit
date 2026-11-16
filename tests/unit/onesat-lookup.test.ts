import { describe, expect, it } from 'vitest';
import { LockingScript, Transaction } from '@bsv/sdk';
import {
  OneSatTransactionLookupProvider,
  type OneSatLookupServices,
} from '@/adapters/ordinals/onesat-minting.adapter';

const OWNER_SCRIPT = '76a914aabbccddeeff00112233445566778899aabbccdd88ac';

function buildTx(satoshis: number): Transaction {
  const tx = new Transaction();
  tx.addOutput({
    lockingScript: LockingScript.fromHex(OWNER_SCRIPT),
    satoshis,
  });
  return tx;
}

function fakeServices(params: {
  rawTx: Transaction;
  blockHeight?: number;
  getHeight: () => Promise<number>;
}): OneSatLookupServices {
  return {
    beef: {
      getRawTx: async () => Uint8Array.from(params.rawTx.toBinary()),
    },
    txo: {
      getByTxid: async () =>
        (params.blockHeight !== undefined
          ? [{ blockHeight: params.blockHeight }]
          : []) as unknown as Awaited<
          ReturnType<OneSatLookupServices['txo']['getByTxid']>
        >,
    },
    getHeight: params.getHeight,
  };
}

function providerFor(services: OneSatLookupServices) {
  return new OneSatTransactionLookupProvider({ network: 'test', services });
}

describe('OneSatTransactionLookupProvider — never fabricates confirmations', () => {
  it('reports 0 confirmations (not 1) when the chain tip height lookup fails', async () => {
    const tx = buildTx(1);
    const provider = providerFor(
      fakeServices({
        rawTx: tx,
        blockHeight: 900_000,
        getHeight: async () => {
          throw new Error('indexer unavailable');
        },
      })
    );

    const observed = await provider.getTransaction(tx.id('hex'), 'test');
    expect(observed).not.toBeNull();
    expect(observed?.blockHeight).toBe(900_000);
    expect(observed?.confirmations).toBe(0);
  });

  it('reports 0 confirmations when the tip height is behind the reported block height', async () => {
    const tx = buildTx(1);
    const provider = providerFor(
      fakeServices({
        rawTx: tx,
        blockHeight: 900_000,
        getHeight: async () => 899_990,
      })
    );

    const observed = await provider.getTransaction(tx.id('hex'), 'test');
    expect(observed?.confirmations).toBe(0);
  });

  it('reports 0 confirmations for an unmined transaction', async () => {
    const tx = buildTx(1);
    const provider = providerFor(
      fakeServices({ rawTx: tx, getHeight: async () => 900_000 })
    );

    const observed = await provider.getTransaction(tx.id('hex'), 'test');
    expect(observed?.blockHeight).toBeNull();
    expect(observed?.confirmations).toBe(0);
  });

  it('counts confirmations from a consistent chain tip and keeps exact output amounts', async () => {
    const tx = buildTx(1);
    const provider = providerFor(
      fakeServices({
        rawTx: tx,
        blockHeight: 900_000,
        getHeight: async () => 900_001,
      })
    );

    const observed = await provider.getTransaction(tx.id('hex'), 'test');
    expect(observed?.confirmations).toBe(2);
    expect(observed?.outputs).toEqual([
      { vout: 0, satoshis: 1, lockingScriptHex: OWNER_SCRIPT },
    ]);
    expect(observed?.isMock).toBe(false);
  });

  it('returns null when the indexer returns a different transaction than the one requested', async () => {
    const requested = buildTx(1);
    const different = buildTx(2);
    const provider = providerFor(
      fakeServices({
        rawTx: different,
        blockHeight: 900_000,
        getHeight: async () => 900_010,
      })
    );

    const observed = await provider.getTransaction(requested.id('hex'), 'test');
    expect(observed).toBeNull();
  });
});
