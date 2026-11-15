import { OP, Script } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildP2PKHScriptFromPubKeyHash,
  isStandardP2PKHScript,
  parseOrdinalOutputScript,
} from '@/lib/ordinals/script-parser';

const SAMPLE_PKH = '89abcdefabbaabbaabbaabbaabbaabbaabbaabba';
const STANDARD_P2PKH = buildP2PKHScriptFromPubKeyHash(SAMPLE_PKH);

function buildOrdEnvelopeHex(contentType: string, bodyUtf8: string): string {
  const script = new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_IF)
    .writeBin( Array.from(Buffer.from('ord', 'utf8')) )
    .writeOpCode(OP.OP_1)
    .writeBin( Array.from(Buffer.from(contentType, 'utf8')) )
    .writeOpCode(OP.OP_0)
    .writeBin( Array.from(Buffer.from(bodyUtf8, 'utf8')) )
    .writeOpCode(OP.OP_ENDIF);
  return script.toHex();
}

describe('Protocol-Aware 1Sat Ordinals Script Parser', () => {
  it('validates a standard 25-byte P2PKH locking script', () => {
    expect(isStandardP2PKHScript(STANDARD_P2PKH)).toBe(true);
    const parsed = parseOrdinalOutputScript(STANDARD_P2PKH);
    expect(parsed).toEqual({
      rawScriptHex: STANDARD_P2PKH,
      spendingScriptHex: STANDARD_P2PKH,
      scriptType: 'P2PKH',
      isPayoutRoutable: true,
      pubKeyHashHex: SAMPLE_PKH,
      hasOrdEnvelope: false,
      contentType: null,
    });
  });

  it('extracts the underlying P2PKH script when prefixed by a 1Sat "ord" inscription envelope', () => {
    const ordEnvelope = buildOrdEnvelopeHex(
      'application/json',
      JSON.stringify({ app: 'community-platform', name: 'Tech' })
    );
    const combinedHex = `${ordEnvelope}${STANDARD_P2PKH}`;

    const parsed = parseOrdinalOutputScript(combinedHex);
    expect(parsed.hasOrdEnvelope).toBe(true);
    expect(parsed.contentType).toBe('application/json');
    expect(parsed.scriptType).toBe('P2PKH');
    expect(parsed.isPayoutRoutable).toBe(true);
    expect(parsed.spendingScriptHex).toBe(STANDARD_P2PKH);
    expect(parsed.pubKeyHashHex).toBe(SAMPLE_PKH);
  });

  it('extracts the underlying P2PKH script when suffixed by an "ord" envelope and trailing OP_RETURN MAP metadata', () => {
    const ordEnvelope = buildOrdEnvelopeHex('image/png', 'PNGDATA');
    const mapSuffix = new Script()
      .writeOpCode(OP.OP_RETURN)
      .writeBin(Array.from(Buffer.from('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5', 'utf8')))
      .writeBin(Array.from(Buffer.from('SET', 'utf8')))
      .writeBin(Array.from(Buffer.from('app', 'utf8')))
      .writeBin(Array.from(Buffer.from('community-platform', 'utf8')))
      .toHex();

    const combinedHex = `${STANDARD_P2PKH}${ordEnvelope}${mapSuffix}`;
    const parsed = parseOrdinalOutputScript(combinedHex);

    expect(parsed.hasOrdEnvelope).toBe(true);
    expect(parsed.contentType).toBe('image/png');
    expect(parsed.scriptType).toBe('P2PKH');
    expect(parsed.isPayoutRoutable).toBe(true);
    expect(parsed.spendingScriptHex).toBe(STANDARD_P2PKH);
  });

  it('rejects non-P2PKH custom or covenant scripts and marks isPayoutRoutable = false', () => {
    const ordEnvelope = buildOrdEnvelopeHex('text/plain', 'locked ordinal');
    // Custom script that is NOT standard P2PKH (e.g. OP_2 <pub1> <pub2> OP_2 OP_CHECKMULTISIG)
    const nonStandardLock = new Script()
      .writeOpCode(OP.OP_2)
      .writeBin(new Array(33).fill(0x02))
      .writeBin(new Array(33).fill(0x03))
      .writeOpCode(OP.OP_2)
      .writeOpCode(OP.OP_CHECKMULTISIG)
      .toHex();

    const parsed = parseOrdinalOutputScript(`${ordEnvelope}${nonStandardLock}`);
    expect(parsed.hasOrdEnvelope).toBe(true);
    expect(parsed.scriptType).toBe('NON_STANDARD');
    expect(parsed.isPayoutRoutable).toBe(false);
    expect(parsed.pubKeyHashHex).toBeNull();
  });

  it('handles empty or malformed scripts safely without throwing', () => {
    const emptyParsed = parseOrdinalOutputScript('');
    expect(emptyParsed.scriptType).toBe('EMPTY');
    expect(emptyParsed.isPayoutRoutable).toBe(false);

    const invalidHexParsed = parseOrdinalOutputScript('not-hex-data');
    expect(invalidHexParsed.scriptType).toBe('EMPTY');
    expect(invalidHexParsed.isPayoutRoutable).toBe(false);
  });
});
