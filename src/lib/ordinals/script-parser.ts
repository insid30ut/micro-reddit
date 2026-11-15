import { OP, Script } from '@bsv/sdk';
import type { ParsedOrdinalScript, ScriptClassification } from '@/types/ordinal';

/**
 * Standard 25-byte P2PKH locking script hex pattern:
 * OP_DUP (0x76) OP_HASH160 (0xa9) PUSH_20 (0x14) <20-byte-pubKeyHash> OP_EQUALVERIFY (0x88) OP_CHECKSIG (0xac)
 */
const P2PKH_HEX_REGEX = /^76a914([0-9a-f]{40})88ac$/i;

function bytesToUtf8(bytes: number[] | undefined): string {
  if (!bytes || bytes.length === 0) {
    return '';
  }
  return Buffer.from(bytes).toString('utf8');
}

function bytesToHex(bytes: number[] | undefined): string {
  if (!bytes || bytes.length === 0) {
    return '';
  }
  return Buffer.from(bytes).toString('hex').toLowerCase();
}

/**
 * Checks whether a locking script hex string is a strict 25-byte standard P2PKH script.
 */
export function isStandardP2PKHScript(scriptHex: string): boolean {
  return P2PKH_HEX_REGEX.test(scriptHex.trim());
}

/**
 * Builds a standard 25-byte P2PKH locking script from a 20-byte (40-hex-char) public key hash.
 */
export function buildP2PKHScriptFromPubKeyHash(pubKeyHashHex: string): string {
  const normalized = pubKeyHashHex.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(
      `Invalid pubKeyHashHex: expected 40 hex characters (20 bytes), received "${pubKeyHashHex}".`
    );
  }
  return `76a914${normalized}88ac`;
}

/**
 * Builds a genuine 1Sat Ordinal inscription locking script:
 * `OP_FALSE OP_IF "ord" OP_1 <contentType> OP_0 <contentBytes> OP_ENDIF <25-byte P2PKH script>`
 *
 * The underlying spending condition is a standard 25-byte P2PKH locking script.
 */
export function build1SatOrdinalLockingScript(params: {
  ownerP2PKHScriptHex: string;
  contentBytes: Uint8Array;
  contentType: string;
}): string {
  const normalizedOwnerScript = params.ownerP2PKHScriptHex.trim().toLowerCase();
  if (!isStandardP2PKHScript(normalizedOwnerScript)) {
    throw new Error(
      `Invalid ownerP2PKHScriptHex: expected a 25-byte standard P2PKH locking script, received "${params.ownerP2PKHScriptHex}".`
    );
  }
  const trimmedType = params.contentType.trim();
  if (!trimmedType || trimmedType.length > 255) {
    throw new Error('Inscription contentType must be a non-empty MIME string (<= 255 chars).');
  }

  const script = new Script();
  // 1Sat Ordinal envelope prefix: OP_FALSE OP_IF "ord" OP_1 <contentType> OP_0 <content> OP_ENDIF
  script.writeOpCode(OP.OP_FALSE);
  script.writeOpCode(OP.OP_IF);
  script.writeBin(Array.from(Buffer.from('ord', 'utf8')));
  script.writeOpCode(OP.OP_1);
  script.writeBin(Array.from(Buffer.from(trimmedType, 'utf8')));
  script.writeOpCode(OP.OP_0);
  script.writeBin(Array.from(params.contentBytes));
  script.writeOpCode(OP.OP_ENDIF);

  // Append underlying P2PKH spending condition
  const p2pkhScript = Script.fromHex(normalizedOwnerScript);
  for (const chunk of p2pkhScript.chunks) {
    script.chunks.push(chunk);
  }

  return script.toHex().toLowerCase();
}

export interface ExtractedOrdinalInscription {
  hasOrdEnvelope: boolean;
  contentType: string | null;
  contentHex: string | null;
  contentUtf8: string | null;
}

/**
 * Extracts the 1Sat Ordinal inscription envelope (`OP_FALSE OP_IF "ord" ... OP_ENDIF`)
 * MIME content-type and raw payload from an output locking script hex.
 */
export function extractOrdinalInscriptionEnvelope(
  rawScriptHex: string
): ExtractedOrdinalInscription {
  const normalizedRaw = rawScriptHex.trim().toLowerCase();
  if (
    normalizedRaw.length === 0 ||
    normalizedRaw.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(normalizedRaw)
  ) {
    return {
      hasOrdEnvelope: false,
      contentType: null,
      contentHex: null,
      contentUtf8: null,
    };
  }

  let parsedScript: Script;
  try {
    parsedScript = Script.fromHex(normalizedRaw);
  } catch {
    return {
      hasOrdEnvelope: false,
      contentType: null,
      contentHex: null,
      contentUtf8: null,
    };
  }

  const chunks = parsedScript.chunks;
  for (let i = 0; i < chunks.length - 2; i++) {
    const chunk = chunks[i];
    const nextChunk = chunks[i + 1];
    if (
      chunk &&
      nextChunk &&
      chunk.op === OP.OP_FALSE &&
      nextChunk.op === OP.OP_IF
    ) {
      let endIfIndex = -1;
      let depth = 1;
      for (let j = i + 2; j < chunks.length; j++) {
        const inner = chunks[j];
        if (!inner) continue;
        if (inner.op === OP.OP_IF || inner.op === OP.OP_NOTIF) {
          depth++;
        } else if (inner.op === OP.OP_ENDIF) {
          depth--;
          if (depth === 0) {
            endIfIndex = j;
            break;
          }
        }
      }

      if (endIfIndex !== -1) {
        const markerStr = bytesToUtf8(chunks[i + 2]?.data);
        if (markerStr === 'ord') {
          let contentType: string | null = null;
          let contentHex: string | null = null;
          let contentUtf8: string | null = null;

          let k = i + 3;
          while (k < endIfIndex) {
            const tagChunk = chunks[k];
            const valChunk = chunks[k + 1];
            if (!tagChunk || k + 1 >= endIfIndex || !valChunk) {
              break;
            }
            const isField1 =
              tagChunk.op === OP.OP_1 ||
              (tagChunk.data !== undefined &&
                tagChunk.data.length === 1 &&
                tagChunk.data[0] === 1);
            const isField0 =
              tagChunk.op === OP.OP_0 ||
              tagChunk.op === OP.OP_FALSE ||
              (tagChunk.data !== undefined &&
                tagChunk.data.length === 1 &&
                tagChunk.data[0] === 0);

            if (isField1 && valChunk.data) {
              contentType = bytesToUtf8(valChunk.data);
            } else if (isField0) {
              const rawBytes = valChunk.data ?? [];
              contentHex = bytesToHex(rawBytes);
              contentUtf8 = bytesToUtf8(rawBytes);
            }
            k += 2;
          }

          return {
            hasOrdEnvelope: true,
            contentType,
            contentHex,
            contentUtf8,
          };
        }
      }
    }
  }

  return {
    hasOrdEnvelope: false,
    contentType: null,
    contentHex: null,
    contentUtf8: null,
  };
}

/**
 * Protocol-aware 1Sat Ordinals locking script parser.
 *
 * Never assumes an inscription output uses a standard P2PKH locking script.
 * Parses the script into @bsv/sdk opcode chunks, strips 1Sat "ord" inscription
 * envelopes (`OP_FALSE OP_IF "ord" ... OP_ENDIF`) and trailing `OP_RETURN`
 * metadata segments (such as MAP/Sigma), and classifies the underlying
 * spending condition (`P2PKH`, `ORDLOCK`, `NON_STANDARD`, or `EMPTY`).
 */
export function parseOrdinalOutputScript(rawScriptHex: string): ParsedOrdinalScript {
  const normalizedRaw = rawScriptHex.trim().toLowerCase();

  if (normalizedRaw.length === 0 || normalizedRaw.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalizedRaw)) {
    return {
      rawScriptHex: normalizedRaw,
      spendingScriptHex: '',
      scriptType: 'EMPTY',
      isPayoutRoutable: false,
      pubKeyHashHex: null,
      hasOrdEnvelope: false,
      contentType: null,
    };
  }

  let parsedScript: Script;
  try {
    parsedScript = Script.fromHex(normalizedRaw);
  } catch {
    return {
      rawScriptHex: normalizedRaw,
      spendingScriptHex: normalizedRaw,
      scriptType: 'NON_STANDARD',
      isPayoutRoutable: false,
      pubKeyHashHex: null,
      hasOrdEnvelope: false,
      contentType: null,
    };
  }

  const chunks = parsedScript.chunks;
  const spendingChunks: typeof chunks = [];
  let hasOrdEnvelope = false;
  let contentType: string | null = null;

  let i = 0;
  while (i < chunks.length) {
    const chunk = chunks[i];
    const nextChunk = chunks[i + 1];

    // Detect `OP_FALSE OP_IF ... OP_ENDIF` envelope (1Sat Ordinal inscription envelope)
    if (
      chunk &&
      nextChunk &&
      chunk.op === OP.OP_FALSE &&
      nextChunk.op === OP.OP_IF
    ) {
      let endIfIndex = -1;
      let depth = 1;
      for (let j = i + 2; j < chunks.length; j++) {
        const inner = chunks[j];
        if (!inner) continue;
        if (inner.op === OP.OP_IF || inner.op === OP.OP_NOTIF) {
          depth++;
        } else if (inner.op === OP.OP_ENDIF) {
          depth--;
          if (depth === 0) {
            endIfIndex = j;
            break;
          }
        }
      }

      if (endIfIndex !== -1) {
        const markerChunk = chunks[i + 2];
        const markerStr = bytesToUtf8(markerChunk?.data);
        if (markerStr === 'ord') {
          hasOrdEnvelope = true;
          for (let k = i + 3; k < endIfIndex; k++) {
            const c = chunks[k];
            const valChunk = chunks[k + 1];
            if (
              c &&
              valChunk &&
              (c.op === OP.OP_1 || (c.data && c.data.length === 1 && c.data[0] === 1)) &&
              valChunk.data
            ) {
              contentType = bytesToUtf8(valChunk.data);
              break;
            }
          }
        }
        // Skip the entire OP_FALSE OP_IF ... OP_ENDIF envelope
        i = endIfIndex + 1;
        // Skip optional OP_CODESEPARATOR immediately following an envelope
        if (chunks[i]?.op === OP.OP_CODESEPARATOR) {
          i++;
        }
        continue;
      }
    }

    // Strip trailing OP_RETURN metadata (e.g., MAP protocol or Sigma attestation)
    // Only treat OP_RETURN as trailing metadata when it is NOT preceded by OP_FALSE
    if (chunk && chunk.op === OP.OP_RETURN) {
      break;
    }
    if (
      chunk &&
      nextChunk &&
      chunk.op === OP.OP_FALSE &&
      nextChunk.op === OP.OP_RETURN
    ) {
      break;
    }

    if (chunk && chunk.op !== OP.OP_CODESEPARATOR) {
      spendingChunks.push(chunk);
    }
    i++;
  }

  const spendingScript = new Script(spendingChunks);
  const spendingScriptHex = spendingScript.toHex().toLowerCase();

  if (spendingScriptHex.length === 0) {
    return {
      rawScriptHex: normalizedRaw,
      spendingScriptHex: '',
      scriptType: 'EMPTY',
      isPayoutRoutable: false,
      pubKeyHashHex: null,
      hasOrdEnvelope,
      contentType,
    };
  }

  // Check if the extracted spending condition is a strict 5-chunk standard P2PKH script
  const p2pkhMatch = P2PKH_HEX_REGEX.exec(spendingScriptHex);
  if (
    p2pkhMatch &&
    p2pkhMatch[1] &&
    spendingChunks.length === 5 &&
    spendingChunks[0]?.op === OP.OP_DUP &&
    spendingChunks[1]?.op === OP.OP_HASH160 &&
    spendingChunks[2]?.data?.length === 20 &&
    spendingChunks[3]?.op === OP.OP_EQUALVERIFY &&
    spendingChunks[4]?.op === OP.OP_CHECKSIG
  ) {
    return {
      rawScriptHex: normalizedRaw,
      spendingScriptHex,
      scriptType: 'P2PKH',
      isPayoutRoutable: true,
      pubKeyHashHex: bytesToHex(spendingChunks[2].data),
      hasOrdEnvelope,
      contentType,
    };
  }

  // Heuristic detection of OrdLock / sCrypt covenant scripts vs generic non-standard scripts
  const isOrdLockLike =
    spendingChunks.length > 10 &&
    spendingChunks.some((c) => c.op === OP.OP_CHECKSIG || c.op === OP.OP_HASH256);

  const scriptType: ScriptClassification = isOrdLockLike ? 'ORDLOCK' : 'NON_STANDARD';

  return {
    rawScriptHex: normalizedRaw,
    spendingScriptHex,
    scriptType,
    isPayoutRoutable: false,
    pubKeyHashHex: null,
    hasOrdEnvelope,
    contentType,
  };
}
