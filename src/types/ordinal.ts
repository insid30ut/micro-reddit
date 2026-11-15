export type ScriptClassification = 'P2PKH' | 'ORDLOCK' | 'NON_STANDARD' | 'EMPTY';

export interface ParsedOrdinalScript {
  /** Full original locking script in lowercase hex */
  rawScriptHex: string;
  /** Extracted underlying spending condition script in lowercase hex (envelope & OP_RETURN stripped) */
  spendingScriptHex: string;
  /** Classification of the extracted spending condition */
  scriptType: ScriptClassification;
  /** True ONLY if spendingScriptHex is a verified standard 25-byte P2PKH locking script */
  isPayoutRoutable: boolean;
  /** Extracted 20-byte public key hash in lowercase hex (present only when scriptType === 'P2PKH') */
  pubKeyHashHex: string | null;
  /** True if a 1Sat "ord" inscription envelope was detected inside the script */
  hasOrdEnvelope: boolean;
  /** Detected MIME content-type inside the "ord" envelope if present */
  contentType: string | null;
}

export interface OrdinalOwnershipState {
  /** Permanent genesis identifier: "<originTxid>_<originVout>" */
  origin: string;
  originTxid: string;
  originVout: number;
  /** Current unspent outpoint: "<currentTxid>_<currentVout>" */
  currentOutpoint: string;
  currentTxid: string;
  currentVout: number;
  /** Extracted underlying spending condition locking script in hex */
  currentOwnerScript: string;
  rawOutputScript: string;
  scriptType: ScriptClassification;
  isPayoutRoutable: boolean;
  blockHeight: number | null;
  confirmations: number;
  confirmationStatus: 'UNCONFIRMED' | 'CONFIRMED' | 'ORPHANED';
  isMock: boolean;
}
