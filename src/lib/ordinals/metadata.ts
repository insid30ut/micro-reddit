import { Hash } from '@bsv/sdk';
import type { CommunityNftMetadataV1 } from '@/types/community';

export const COMMUNITY_NFT_METADATA_MIME_TYPE = 'application/json';

/**
 * Artwork links must be plain http(s) URLs (max 2048 chars). Shared by community creation
 * and NFT metadata validation so a stored community can always be serialized and minted.
 */
export function isValidHttpOrHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateCommunityNftMetadataCandidate(
  candidate: unknown
): { success: true; data: CommunityNftMetadataV1 } | { success: false; error: string } {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { success: false, error: 'root: expected object' };
  }
  const obj = candidate as Record<string, unknown>;
  const issues: string[] = [];

  if (obj.app !== 'community-platform') {
    issues.push('app: must equal "community-platform"');
  }
  if (obj.platform !== 'community-platform') {
    issues.push('platform: must equal "community-platform"');
  }
  if (obj.schemaVersion !== 1) {
    issues.push('schemaVersion: must equal 1');
  }
  if (obj.type !== 'ord') {
    issues.push('type: must equal "ord"');
  }
  if (
    typeof obj.communityId !== 'string' ||
    obj.communityId.length < 1 ||
    obj.communityId.length > 128
  ) {
    issues.push('communityId: must be a non-empty string (1..128 chars)');
  }
  if (
    typeof obj.name !== 'string' ||
    obj.name.length < 1 ||
    obj.name.length > 120
  ) {
    issues.push('name: must be a non-empty string (1..120 chars)');
  }
  if (
    typeof obj.description !== 'string' ||
    obj.description.length < 1 ||
    obj.description.length > 2000
  ) {
    issues.push('description: must be a non-empty string (1..2000 chars)');
  }
  if (
    obj.artworkUrl !== null &&
    (typeof obj.artworkUrl !== 'string' || !isValidHttpOrHttpsUrl(obj.artworkUrl))
  ) {
    issues.push('artworkUrl: must be null or a valid URL');
  }

  if (issues.length > 0) {
    return { success: false, error: issues.join('; ') };
  }

  return {
    success: true,
    data: {
      app: 'community-platform',
      artworkUrl: obj.artworkUrl as string | null,
      communityId: obj.communityId as string,
      description: obj.description as string,
      name: obj.name as string,
      platform: 'community-platform',
      schemaVersion: 1,
      type: 'ord',
    },
  };
}

export interface BuildCommunityNftMetadataInput {
  communityId: string;
  name: string;
  description: string;
  artworkUrl?: string | null;
}

export interface SerializedCommunityNftMetadata {
  metadata: CommunityNftMetadataV1;
  /** Canonical deterministic JSON string (fixed lexicographical key order, no extra whitespace) */
  canonicalJson: string;
  /** UTF-8 bytes of `canonicalJson` */
  contentBytes: Uint8Array;
  /** Base64 encoding of `contentBytes` for inscription APIs */
  contentBase64: string;
  /** Lowercase hex SHA-256 digest of `contentBytes` */
  contentSha256Hex: string;
  /** MIME content type (`application/json`) */
  contentType: typeof COMMUNITY_NFT_METADATA_MIME_TYPE;
  /** Stringified MAP key-value attributes for 1Sat Ordinal indexers */
  mapAttributes: Record<string, string>;
}

function normalizeString(value: string): string {
  return value.trim().normalize('NFC');
}

/**
 * Constructs a validated Version 1 1Sat Ordinals metadata object for a community NFT.
 *
 * Keeps permanent NFT identification (`communityId`, and on-chain `origin = <txid>_<vout>`)
 * separate from mutable community settings stored in PostgreSQL.
 */
export function buildCommunityNftMetadata(
  input: BuildCommunityNftMetadataInput
): CommunityNftMetadataV1 {
  const artworkRaw =
    input.artworkUrl !== undefined &&
    input.artworkUrl !== null &&
    input.artworkUrl.trim().length > 0
      ? normalizeString(input.artworkUrl)
      : null;

  const candidate: CommunityNftMetadataV1 = {
    app: 'community-platform',
    artworkUrl: artworkRaw,
    communityId: normalizeString(input.communityId),
    description: normalizeString(input.description),
    name: normalizeString(input.name),
    platform: 'community-platform',
    schemaVersion: 1,
    type: 'ord',
  };

  const validation = validateCommunityNftMetadataCandidate(candidate);
  if (!validation.success) {
    throw new InvalidNftMetadataError(
      'INVALID_METADATA_SCHEMA',
      `Invalid CommunityNftMetadataV1: ${validation.error}`
    );
  }
  return validation.data;
}

/**
 * Deterministically serializes a `CommunityNftMetadataV1` object into canonical JSON.
 *
 * Keys are emitted in strict lexicographical order:
 * `["app", "artworkUrl", "communityId", "description", "name", "platform", "schemaVersion", "type"]`
 * with NFC-normalized UTF-8 strings and no extraneous whitespace.
 */
export function serializeCommunityNftMetadataDeterministically(
  input: BuildCommunityNftMetadataInput | CommunityNftMetadataV1
): SerializedCommunityNftMetadata {
  const validated = buildCommunityNftMetadata(input);

  // Construct an object with keys in strict canonical alphabetical order
  const canonicalOrderedObject: CommunityNftMetadataV1 = {
    app: validated.app,
    artworkUrl: validated.artworkUrl,
    communityId: validated.communityId,
    description: validated.description,
    name: validated.name,
    platform: validated.platform,
    schemaVersion: validated.schemaVersion,
    type: validated.type,
  };

  const canonicalJson = JSON.stringify(canonicalOrderedObject);
  const buffer = Buffer.from(canonicalJson, 'utf8');
  const contentBytes = new Uint8Array(buffer);
  const contentBase64 = buffer.toString('base64');
  const contentSha256Hex = Buffer.from(
    Hash.sha256(Array.from(contentBytes))
  )
    .toString('hex')
    .toLowerCase();

  const mapAttributes: Record<string, string> = {
    app: validated.app,
    communityId: validated.communityId,
    name: validated.name,
    platform: validated.platform,
    schemaVersion: String(validated.schemaVersion),
    type: validated.type,
    ...(validated.artworkUrl ? { artworkUrl: validated.artworkUrl } : {}),
  };

  return {
    metadata: canonicalOrderedObject,
    canonicalJson,
    contentBytes,
    contentBase64,
    contentSha256Hex,
    contentType: COMMUNITY_NFT_METADATA_MIME_TYPE,
    mapAttributes,
  };
}

export class InvalidNftMetadataError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'InvalidNftMetadataError';
    this.code = code;
  }
}

/**
 * Parses and validates a raw UTF-8 JSON inscription payload against `CommunityNftMetadataV1Schema`,
 * optionally enforcing an exact `expectedCommunityId` match.
 */
export function parseAndVerifyCommunityNftMetadata(
  rawJsonUtf8: string,
  expectedCommunityId?: string
): CommunityNftMetadataV1 {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJsonUtf8);
  } catch {
    throw new InvalidNftMetadataError(
      'MALFORMED_METADATA_JSON',
      'Inscription payload is not valid JSON.'
    );
  }

  const result = validateCommunityNftMetadataCandidate(parsedJson);
  if (!result.success) {
    throw new InvalidNftMetadataError(
      'INVALID_METADATA_SCHEMA',
      `Inscription metadata does not conform to CommunityNftMetadataV1: ${result.error}`
    );
  }

  if (
    expectedCommunityId !== undefined &&
    result.data.communityId !== expectedCommunityId.trim()
  ) {
    throw new InvalidNftMetadataError(
      'COMMUNITY_ID_MISMATCH',
      `Inscription metadata communityId "${result.data.communityId}" does not match expected community "${expectedCommunityId}".`
    );
  }

  return result.data;
}
