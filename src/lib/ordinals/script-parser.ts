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
          // Walk inside the ord envelope to find OP_1 (content-type tag) followed by MIME bytes
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
