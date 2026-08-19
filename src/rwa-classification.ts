/**
 * Reference reader for the RWA asset classification convention drafted in
 * `docs/srfc-rwa-classification.md`.
 *
 * Pure functions over data you have already fetched — no RPC client, no crypto,
 * no dependencies — so the same module runs on native, web, and inside the MV3
 * extension. Signature verification is an injected seam (`SignatureVerifier`)
 * for the same reason.
 *
 * The load-bearing rule, from §5 of the spec: nothing here is an authorization
 * decision. Transfer eligibility is enforced on-chain by the token's own
 * extensions. This module only decides how much to trust a *description*.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** Closed set (spec §2.1). Additions require a version bump. */
export const RWA_CLASSES = [
  'real-estate',
  'treasury',
  'corporate-credit',
  'private-credit',
  'public-equity',
  'private-equity',
  'commodity',
  'fund',
  'carbon',
  'receivable',
  'other',
] as const;

export type RwaClass = (typeof RWA_CLASSES)[number];

/**
 * Closed set (spec §2.2). Orthogonal to `RwaClass`: a mortgage note and an
 * equity stake in the same building are both `real-estate` with inverted risk.
 */
export const RWA_CLAIMS = [
  'equity',
  'preferred-equity',
  'debt-senior',
  'debt-mezzanine',
  'fund-lp',
  'revenue-share',
  'direct-title',
  'derivative',
] as const;

export type RwaClaim = (typeof RWA_CLAIMS)[number];

/**
 * Open registry (spec §2.3) — unknown values are surfaced, not rejected. The
 * real-estate vocabulary tracks the NCREIF/NAREIT core property types.
 */
export const RWA_SUBCLASSES: Readonly<Record<RwaClass, readonly string[]>> = {
  'real-estate': [
    'multifamily',
    'industrial',
    'office',
    'retail',
    'hospitality',
    'self-storage',
    'data-center',
    'senior-housing',
    'single-family-rental',
    'land',
    'mixed-use',
    'specialty',
  ],
  treasury: ['bill', 'note', 'bond', 'money-market'],
  'corporate-credit': ['investment-grade', 'high-yield', 'convertible'],
  'private-credit': ['direct-lending', 'mezzanine', 'venture-debt'],
  'public-equity': [],
  'private-equity': ['buyout', 'growth', 'venture'],
  commodity: ['metal', 'energy', 'agricultural'],
  fund: ['open-end', 'closed-end', 'interval'],
  carbon: ['removal', 'avoidance'],
  receivable: ['trade', 'invoice', 'royalty'],
  other: [],
};

/** Spec version this reader implements. */
export const SUPPORTED_VERSION = '1';

/* ------------------------------------------------------------------ */
/* Layer 1 — classification                                            */
/* ------------------------------------------------------------------ */

/** Parsed `rwa.*` keys from a Token-2022 mint's `additionalMetadata`. */
export type Classification = {
  version: string;
  assetClass: RwaClass;
  claim: RwaClaim;
  /** Free-form; check `isKnownSubclass` before relying on it. */
  subclass?: string;
  /** ISO 3166-1 alpha-2 or 3166-2, e.g. `US` or `US-TX`. */
  jurisdiction?: string;
  /** ISO 17442 LEI. Well-formedness is checked; existence is not. */
  issuerLei?: string;
  /** Base58 pubkey of the SAS attestation account. */
  attestation?: string;
  /** Discovery document URL (spec §4). Unattested — treat as a hint. */
  apiUrl?: string;
  /** `rwa.*` keys this reader did not recognize, preserved for forward compat. */
  unrecognized: Readonly<Record<string, string>>;
};

export type ParseResult =
  | { ok: true; classification: Classification; issues: readonly string[] }
  | { ok: false; issues: readonly string[] };

/**
 * Parse the `rwa.*` subset of a mint's `additionalMetadata` key/value pairs.
 *
 * Accepts the tuple-array shape both the Token-2022 SDK and `jsonParsed` RPC
 * responses produce. Non-`rwa.` keys are ignored entirely.
 *
 * Fatal (`ok: false`): missing or unsupported `rwa.v`, missing or out-of-set
 * `rwa.class` / `rwa.claim`. Everything else is reported in `issues` while
 * still returning a usable classification.
 */
export function parseClassification(
  entries: readonly (readonly [string, string])[]
): ParseResult {
  const issues: string[] = [];
  const fields: Record<string, string> = {};

  for (const entry of entries) {
    const [key, value] = entry;
    if (!key.startsWith('rwa.')) continue;
    // First occurrence wins: a duplicate key is a plausible obfuscation trick,
    // so it is surfaced rather than silently resolved.
    if (key in fields) {
      issues.push(`duplicate key "${key}" ignored`);
      continue;
    }
    fields[key] = value;
  }

  if (Object.keys(fields).length === 0) {
    return { ok: false, issues: ['no rwa.* metadata present'] };
  }

  const version = fields['rwa.v'];
  if (version === undefined) return { ok: false, issues: [...issues, 'missing rwa.v'] };
  if (version !== SUPPORTED_VERSION) {
    // Refuse rather than guess: a later version may redefine these enums.
    return {
      ok: false,
      issues: [...issues, `unsupported rwa.v "${version}" (this reader implements ${SUPPORTED_VERSION})`],
    };
  }

  const rawClass = fields['rwa.class'];
  if (rawClass === undefined) return { ok: false, issues: [...issues, 'missing rwa.class'] };
  if (!isRwaClass(rawClass)) {
    return { ok: false, issues: [...issues, `unknown rwa.class "${rawClass}"`] };
  }

  const rawClaim = fields['rwa.claim'];
  if (rawClaim === undefined) return { ok: false, issues: [...issues, 'missing rwa.claim'] };
  if (!isRwaClaim(rawClaim)) {
    return { ok: false, issues: [...issues, `unknown rwa.claim "${rawClaim}"`] };
  }

  const subclass = fields['rwa.subclass'];
  if (subclass !== undefined && !isKnownSubclass(rawClass, subclass)) {
    issues.push(`unregistered rwa.subclass "${subclass}" for class "${rawClass}"`);
  }

  const jurisdiction = fields['rwa.jurisdiction'];
  if (jurisdiction !== undefined && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction)) {
    issues.push(`malformed rwa.jurisdiction "${jurisdiction}" (expected ISO 3166 form)`);
  }

  const issuerLei = fields['rwa.issuer_lei'];
  if (issuerLei !== undefined && !isWellFormedLei(issuerLei)) {
    issues.push(`malformed rwa.issuer_lei "${issuerLei}" (failed ISO 17442 checksum)`);
  }

  const apiUrl = fields['rwa.api'];
  if (apiUrl !== undefined && !apiUrl.startsWith('https://')) {
    issues.push('rwa.api must be https');
  }

  const known = new Set([
    'rwa.v',
    'rwa.class',
    'rwa.claim',
    'rwa.subclass',
    'rwa.jurisdiction',
    'rwa.issuer_lei',
    'rwa.attestation',
    'rwa.api',
  ]);
  const unrecognized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!known.has(key)) unrecognized[key] = value;
  }

  return {
    ok: true,
    issues,
    classification: {
      version,
      assetClass: rawClass,
      claim: rawClaim,
      subclass,
      jurisdiction,
      issuerLei,
      attestation: fields['rwa.attestation'],
      apiUrl,
      unrecognized,
    },
  };
}

export function isRwaClass(value: string): value is RwaClass {
  return (RWA_CLASSES as readonly string[]).includes(value);
}

export function isRwaClaim(value: string): value is RwaClaim {
  return (RWA_CLAIMS as readonly string[]).includes(value);
}

export function isKnownSubclass(assetClass: RwaClass, subclass: string): boolean {
  return RWA_SUBCLASSES[assetClass].includes(subclass);
}

/**
 * ISO 17442 LEI check: 20 alphanumerics whose mod-97-10 (ISO 7064) residue is 1.
 * Proves shape only — confirming the entity exists means asking GLEIF.
 */
export function isWellFormedLei(lei: string): boolean {
  if (!/^[0-9A-Z]{20}$/.test(lei)) return false;

  let remainder = 0;
  for (const char of lei) {
    const code = char.charCodeAt(0);
    // Letters expand to two digits (A=10 … Z=35) before folding in.
    const digits = code >= 65 ? String(code - 55) : char;
    for (const digit of digits) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/* ------------------------------------------------------------------ */
/* Layer 2 — attestation and trust                                     */
/* ------------------------------------------------------------------ */

/**
 * The fields this spec needs from a decoded SAS attestation. Decoding the
 * account itself is the caller's job — it belongs to the SAS SDK, not here.
 */
export type AttestationView = {
  /** Base58 pubkey of the attestation account. */
  address: string;
  /**
   * Base58 pubkey of the SAS Credential account (spec §3.5).
   *
   * The credential, not the attestation's `signer`. A credential's authorized
   * signers rotate; keying a trust set on the signing key means a routine
   * rotation silently invalidates every attestation an attester has issued.
   */
  attester: string;
  /** Mint the attestation is about. */
  mint: string;
  assetClass: string;
  claim: string;
  subclass?: string;
  jurisdiction?: string;
  issuerLei?: string;
  /** Canonical discovery URL (spec §4). Outranks `rwa.api`. */
  discoveryUrl?: string;
  /** Key authorized to sign the discovery document. */
  discoverySigner?: string;
  /** Unix seconds. Mandatory per spec §3. */
  expiresAt: number;
  revoked?: boolean;
};

export type TrustLevel =
  /** Unexpired attestation from an attester the caller trusts. */
  | 'attested'
  /** Attestation exists and has lapsed — distinct from never having had one. */
  | 'expired'
  /** Metadata only, or an attester outside the caller's trust set. */
  | 'self-declared'
  /** Nothing to go on. */
  | 'unknown';

export type TrustAssessment = {
  level: TrustLevel;
  attester?: string;
  /** Attester is also a mint authority — a signature, but not independent review. */
  selfAttested: boolean;
  /** Metadata contradicting the attestation. Non-empty is a tamper signal. */
  conflicts: readonly string[];
  /** Human-readable trace of how `level` was reached. */
  reasons: readonly string[];
};

export type TrustInput = {
  /**
   * Base58 pubkey of the mint being assessed. Required, not optional: an
   * attestation that names a different mint must never confer trust here, and
   * making the caller supply this is the only way to check that.
   */
  mint: string;
  classification?: Classification | null;
  attestation?: AttestationView | null;
  /** Attesters this consumer honours. Caller-owned policy, per spec §3.1. */
  trustedAttesters: readonly string[];
  /** Mint/metadata authorities, used to detect self-attestation. */
  mintAuthorities?: readonly string[];
  /** Unix seconds; defaults to now. */
  now?: number;
};

/**
 * Decide how far to trust a token's classification.
 *
 * Deliberately conservative: an attestation from an untrusted attester carries
 * no more weight than metadata the issuer wrote itself.
 */
export function resolveTrust(input: TrustInput): TrustAssessment {
  const { mint, classification, attestation, trustedAttesters, mintAuthorities = [] } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const reasons: string[] = [];

  if (!classification && !attestation) {
    return {
      level: 'unknown',
      selfAttested: false,
      conflicts: [],
      reasons: ['no classification metadata and no attestation'],
    };
  }

  // A mint mismatch is categorically unlike the field disagreements below.
  // Those are two descriptions of the same subject diverging, which the spec
  // says to surface without picking a side. This is an attestation that is not
  // about this token at all, so it is discarded outright rather than allowed to
  // confer trust — otherwise any real attestation, replayed against any mint,
  // reads as verified. It is still reported, because an attestation bound
  // elsewhere is a louder signal than no attestation at all.
  if (attestation && attestation.mint !== mint) {
    return {
      level: classification ? 'self-declared' : 'unknown',
      selfAttested: false,
      conflicts: [`mint: assessed "${mint}" vs attestation "${attestation.mint}"`],
      reasons: ['attestation is bound to a different mint — disregarded'],
    };
  }

  const conflicts = attestation && classification ? findConflicts(classification, attestation) : [];
  if (conflicts.length > 0) {
    reasons.push('metadata disagrees with attestation');
  }

  if (!attestation) {
    return {
      level: 'self-declared',
      selfAttested: false,
      conflicts,
      reasons: [...reasons, 'no attestation referenced'],
    };
  }

  const selfAttested = mintAuthorities.includes(attestation.attester);
  if (selfAttested) {
    reasons.push('attester is also a mint authority — not independent review');
  }

  if (attestation.revoked) {
    return {
      level: 'self-declared',
      attester: attestation.attester,
      selfAttested,
      conflicts,
      reasons: [...reasons, 'attestation revoked'],
    };
  }

  if (!trustedAttesters.includes(attestation.attester)) {
    return {
      level: 'self-declared',
      attester: attestation.attester,
      selfAttested,
      conflicts,
      reasons: [...reasons, 'attester not in trust set'],
    };
  }

  if (attestation.expiresAt <= now) {
    return {
      level: 'expired',
      attester: attestation.attester,
      selfAttested,
      conflicts,
      reasons: [...reasons, `attestation expired at ${new Date(attestation.expiresAt * 1000).toISOString()}`],
    };
  }

  return {
    level: 'attested',
    attester: attestation.attester,
    selfAttested,
    conflicts,
    reasons: [...reasons, 'unexpired attestation from a trusted attester'],
  };
}

function findConflicts(classification: Classification, attestation: AttestationView): string[] {
  const conflicts: string[] = [];
  const compare = (field: string, meta: string | undefined, attested: string | undefined) => {
    if (meta !== undefined && attested !== undefined && meta !== attested) {
      conflicts.push(`${field}: metadata "${meta}" vs attestation "${attested}"`);
    }
  };

  compare('class', classification.assetClass, attestation.assetClass);
  compare('claim', classification.claim, attestation.claim);
  compare('subclass', classification.subclass, attestation.subclass);
  compare('jurisdiction', classification.jurisdiction, attestation.jurisdiction);
  compare('issuer_lei', classification.issuerLei, attestation.issuerLei);
  return conflicts;
}

/* ------------------------------------------------------------------ */
/* Layer 3 — discovery                                                 */
/* ------------------------------------------------------------------ */

export type DiscoveryDocument = {
  version: string;
  mint: string;
  issuedAt: string;
  expiresAt: string;
  /** Multihash over the pinned document set. */
  manifest?: string;
  endpoints: Readonly<Record<string, string>>;
};

export type DiscoveryResult =
  | { ok: true; document: DiscoveryDocument; issues: readonly string[] }
  | { ok: false; issues: readonly string[] };

/**
 * Verifies a detached ed25519 signature over raw bytes. Injected so this module
 * stays dependency-free; wire it to whatever crypto the platform provides.
 */
export type SignatureVerifier = (
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: string
) => boolean | Promise<boolean>;

/**
 * Parse and structurally validate a discovery document (spec §4.2).
 *
 * Structure only — call `verifyDiscoveryDocument` before trusting the contents.
 */
export function parseDiscoveryDocument(
  raw: string,
  expected: { mint: string; now?: number }
): DiscoveryResult {
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  const issues: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, issues: ['discovery document is not valid JSON'] };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, issues: ['discovery document is not an object'] };
  }
  const doc = parsed as Record<string, unknown>;

  if (doc.version !== SUPPORTED_VERSION) {
    return { ok: false, issues: [`unsupported discovery version "${String(doc.version)}"`] };
  }

  // Binding the document to the mint stops a valid, correctly signed document
  // for one asset being replayed as the description of another.
  if (typeof doc.mint !== 'string' || doc.mint !== expected.mint) {
    return { ok: false, issues: [`discovery document mint mismatch (expected ${expected.mint})`] };
  }

  if (typeof doc.issuedAt !== 'string' || typeof doc.expiresAt !== 'string') {
    return { ok: false, issues: ['missing issuedAt/expiresAt'] };
  }

  const expiresAt = Date.parse(doc.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return { ok: false, issues: [`unparseable expiresAt "${doc.expiresAt}"`] };
  }
  if (expiresAt / 1000 <= now) {
    issues.push(`discovery document expired at ${doc.expiresAt}`);
  }

  const endpoints: Record<string, string> = {};
  if (typeof doc.endpoints === 'object' && doc.endpoints !== null) {
    for (const [name, url] of Object.entries(doc.endpoints as Record<string, unknown>)) {
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        issues.push(`endpoint "${name}" is not an https URL — dropped`);
        continue;
      }
      endpoints[name] = url;
    }
  }

  return {
    ok: true,
    issues,
    document: {
      version: doc.version,
      mint: doc.mint,
      issuedAt: doc.issuedAt,
      expiresAt: doc.expiresAt,
      manifest: typeof doc.manifest === 'string' ? doc.manifest : undefined,
      endpoints,
    },
  };
}

/**
 * Check the detached signature against the key the attestation authorized.
 *
 * Verifies the exact bytes as served — no canonicalization, per spec §4.1,
 * because every divergence between two JSON canonicalizers is a bypass.
 *
 * TLS is not a substitute: it proves you reached the domain, not who wrote the
 * response. A lapsed domain can be re-registered with a valid certificate; the
 * attested signing key cannot.
 */
export async function verifyDiscoveryDocument(
  rawBytes: Uint8Array,
  signature: Uint8Array,
  attestation: AttestationView,
  verify: SignatureVerifier
): Promise<{ verified: boolean; reason: string }> {
  if (!attestation.discoverySigner) {
    return { verified: false, reason: 'attestation names no discovery signer' };
  }
  try {
    const ok = await verify(rawBytes, signature, attestation.discoverySigner);
    return ok
      ? { verified: true, reason: 'signed by the attested discovery key' }
      : { verified: false, reason: 'signature does not match the attested discovery key' };
  } catch (error) {
    return { verified: false, reason: `verification threw: ${String(error)}` };
  }
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/**
 * Badge text for a trust level. Per spec §5, `expired` must never collapse into
 * `unknown` — a lapsed issuer and an absent one are different facts.
 */
export function trustLabel(level: TrustLevel): string {
  switch (level) {
    case 'attested':
      return 'Verified';
    case 'expired':
      return 'Verification expired';
    case 'self-declared':
      return 'Self-declared';
    case 'unknown':
      return 'Unidentified';
  }
}

/** `Multifamily · Equity` — human-readable summary of the two enum axes. */
export function describeClassification(classification: Classification): string {
  const title = (value: string) =>
    value
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  const asset = classification.subclass
    ? title(classification.subclass)
    : title(classification.assetClass);
  return `${asset} · ${title(classification.claim)}`;
}
