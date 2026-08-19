/**
 * Round-trip tests for the `rwa.classification.v1` SAS schema (spec §3.1).
 *
 * These exist because §3 makes claims about a byte layout, and a byte layout
 * claim that nobody encodes is a guess. Everything here goes through the real
 * `sas-lib` serializer rather than a local reimplementation — the point is to
 * fail when the SDK's encoding drifts away from what the document says, which
 * is exactly the signal that should block the spec leaving draft.
 *
 * Offline and deterministic; no network. The live devnet equivalent is
 * `npm run sas:devnet` (spec §3.6).
 */

/// <reference types="node" />

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { serializeAttestationData, deserializeAttestationData } from 'sas-lib';

import { resolveTrust, type AttestationView } from './rwa-classification.ts';

/* ------------------------------------------------------------------ */
/* The schema, exactly as spec §3.1 tabulates it                       */
/* ------------------------------------------------------------------ */

/** Field order is normative: Borsh is positional. */
const SCHEMA_FIELDS = [
  ['mint', 13],
  ['class', 12],
  ['claim', 12],
  ['subclass', 12],
  ['jurisdiction', 12],
  ['issuer_lei', 12],
  ['property_commit', 13],
  ['discovery_url', 12],
  ['discovery_signer', 13],
] as const satisfies readonly (readonly [string, number])[];

/** SAS compact layout codes used by this schema. */
const CODE_STRING = 12;
const CODE_VEC_U8 = 13;

/**
 * Build the on-chain `Schema` account shape the SDK expects. `fieldNames` is a
 * bare concatenation of u32-LE-length-prefixed segments — no outer count.
 */
function schemaAccount(fields: readonly (readonly [string, number])[] = SCHEMA_FIELDS) {
  const encoder = new TextEncoder();
  const segments: Buffer[] = [];
  for (const [name] of fields) {
    const bytes = encoder.encode(name);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    segments.push(length, Buffer.from(bytes));
  }
  return {
    discriminator: 0,
    credential: '1'.repeat(32),
    name: new Uint8Array(),
    description: new Uint8Array(),
    layout: Uint8Array.from(fields.map(([, code]) => code)),
    fieldNames: Buffer.concat(segments),
    isPaused: false,
    version: 1,
  };
}

const MINT_BYTES = Buffer.alloc(32, 7);
const SIGNER_BYTES = Buffer.alloc(32, 3);
const COMMIT_BYTES = Buffer.alloc(32, 9);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    mint: MINT_BYTES,
    class: 'real-estate',
    claim: 'equity',
    subclass: 'multifamily',
    jurisdiction: 'US-TX',
    issuer_lei: '5493001KJTIIGC8Y1R12',
    property_commit: COMMIT_BYTES,
    discovery_url: 'https://issuer.example/.well-known/rwa.json',
    discovery_signer: SIGNER_BYTES,
    ...overrides,
  };
}

const roundTrip = (data: Record<string, unknown>, schema = schemaAccount()) =>
  deserializeAttestationData<Record<string, any>>(
    schema as never,
    serializeAttestationData(schema as never, data)
  );

/** Base58, for the address comparison §5.1 requires. */
function base58(bytes: Uint8Array | number[]): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const buf = Buffer.from(bytes);
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

describe('rwa.classification.v1 — layout', () => {
  test('the schema is nine fields in the order §3.1 tabulates', () => {
    assert.deepEqual(
      SCHEMA_FIELDS.map(([name]) => name),
      ['mint', 'class', 'claim', 'subclass', 'jurisdiction', 'issuer_lei',
       'property_commit', 'discovery_url', 'discovery_signer']
    );
  });

  test('only String and Vec<u8> codes are used', () => {
    // §3.1 leans on this: SAS has no pubkey and no fixed-size byte array, so
    // every field collapses to one of two codes.
    const codes = new Set(SCHEMA_FIELDS.map(([, code]) => code));
    assert.deepEqual([...codes].sort((a, b) => a - b), [CODE_STRING, CODE_VEC_U8]);
  });

  test('the three key/commit fields are Vec<u8>, the rest String', () => {
    const byCode = (code: number) =>
      SCHEMA_FIELDS.filter(([, c]) => c === code).map(([name]) => name);

    assert.deepEqual(byCode(CODE_VEC_U8), ['mint', 'property_commit', 'discovery_signer']);
    assert.deepEqual(byCode(CODE_STRING), [
      'class', 'claim', 'subclass', 'jurisdiction', 'issuer_lei', 'discovery_url',
    ]);
  });

  test('expires_at is absent — the account owns expiry (§3.2)', () => {
    // Carrying a second copy in the payload would create two sources of truth
    // with no rule for which wins. Widened to string[] on purpose: the literal
    // union makes this statically true, and a comparison TS can prove is not a
    // check a future editor of the table would trip over.
    const names: readonly string[] = SCHEMA_FIELDS.map(([name]) => name);

    assert.ok(!names.includes('expires_at'));
  });

  test('a layout/fieldNames length mismatch is rejected by the SDK', () => {
    const broken = schemaAccount();
    broken.layout = Uint8Array.from([CODE_STRING]);

    assert.throws(() => serializeAttestationData(broken as never, payload()), /do not match/i);
  });
});

/* ------------------------------------------------------------------ */
/* Round-trip                                                          */
/* ------------------------------------------------------------------ */

describe('rwa.classification.v1 — round-trip', () => {
  test('a fully populated attestation survives serialize/deserialize', () => {
    const back = roundTrip(payload());

    assert.equal(back.class, 'real-estate');
    assert.equal(back.claim, 'equity');
    assert.equal(back.subclass, 'multifamily');
    assert.equal(back.jurisdiction, 'US-TX');
    assert.equal(back.issuer_lei, '5493001KJTIIGC8Y1R12');
    assert.equal(back.discovery_url, 'https://issuer.example/.well-known/rwa.json');
  });

  test('a fully populated attestation is 228 bytes', () => {
    // Pins the wire size §3.1 quotes. If this moves, the document is stale.
    assert.equal(serializeAttestationData(schemaAccount() as never, payload()).length, 228);
  });

  test('pubkeys survive as 32 raw bytes, not base58', () => {
    const back = roundTrip(payload());

    assert.equal(back.mint.length, 32);
    assert.equal(back.discovery_signer.length, 32);
    assert.ok(Buffer.from(back.mint).equals(MINT_BYTES));
    assert.ok(Buffer.from(back.discovery_signer).equals(SIGNER_BYTES));
  });

  test('a 32-byte Vec<u8> costs 36 bytes on the wire', () => {
    // Length-prefixed, per §3.1 — the reason a "bytes32" field is not free.
    // Measured against a single-field schema so the figure is the whole cost,
    // not the increment.
    const oneField = schemaAccount([['property_commit', CODE_VEC_U8]]);

    assert.equal(
      serializeAttestationData(oneField as never, { property_commit: Buffer.alloc(0) }).length,
      4,
      'an empty Vec<u8> is the 4-byte length prefix alone'
    );
    assert.equal(
      serializeAttestationData(oneField as never, { property_commit: COMMIT_BYTES }).length,
      36,
      '4-byte prefix + 32 bytes'
    );
  });

  test('property_commit may be empty rather than zero-filled', () => {
    const back = roundTrip(payload({ property_commit: Buffer.alloc(0) }));

    assert.equal(back.property_commit.length, 0);
  });

  test('empty optional strings round-trip as empty, not absent', () => {
    const back = roundTrip(payload({ subclass: '', issuer_lei: '' }));

    assert.equal(back.subclass, '');
    assert.equal(back.issuer_lei, '');
  });

  test('non-ASCII survives — jurisdictions and issuer names are not all Latin-1', () => {
    const back = roundTrip(payload({ discovery_url: 'https://issuer.example/köln/rwa.json' }));

    assert.equal(back.discovery_url, 'https://issuer.example/köln/rwa.json');
  });

  test('field order is normative, not decorative', () => {
    // Borsh is positional: encode under a schema whose same-typed fields are
    // transposed and the values land in the wrong slots. Nothing errors, which
    // is precisely why §3.1 pins the order.
    const transposed = schemaAccount(
      SCHEMA_FIELDS.map(([name, code]) =>
        name === 'class' ? (['claim', code] as const)
        : name === 'claim' ? (['class', code] as const)
        : ([name, code] as const)
      )
    );
    const bytes = serializeAttestationData(transposed as never, payload());
    const back = deserializeAttestationData<Record<string, any>>(schemaAccount() as never, bytes);

    assert.equal(back.class, 'equity');
    assert.equal(back.claim, 'real-estate');
  });
});

/* ------------------------------------------------------------------ */
/* Wire bytes through to a trust decision                              */
/* ------------------------------------------------------------------ */

describe('rwa.classification.v1 — decoded payload feeds resolveTrust', () => {
  const CREDENTIAL = '5Es4gSTWYemJxPMkWGYAi56Xzf2cSosJBRMaQaVVuxZq';
  const ATTESTATION = 'G6qArVxuNwL9aC3EpTY443TfVTfyFmKwQhgmnd6rht9b';
  const NOW = 1_786_752_000;

  /**
   * The seam a real caller implements: decoded SAS payload plus the account's
   * own native fields, in. `AttestationView` out. Expiry comes from the
   * account (§3.2); the attester is the credential, not the signer (§3.5).
   */
  function toView(
    decoded: Record<string, any>,
    account: { credential: string; expiry: number }
  ): AttestationView {
    return {
      address: ATTESTATION,
      attester: account.credential,
      mint: base58(decoded.mint),
      assetClass: decoded.class,
      claim: decoded.claim,
      subclass: decoded.subclass || undefined,
      jurisdiction: decoded.jurisdiction || undefined,
      issuerLei: decoded.issuer_lei || undefined,
      discoveryUrl: decoded.discovery_url || undefined,
      discoverySigner: base58(decoded.discovery_signer),
      expiresAt: account.expiry,
    };
  }

  test('wire bytes resolve to attested for a trusted credential', () => {
    const view = toView(roundTrip(payload()), {
      credential: CREDENTIAL,
      expiry: NOW + 86_400,
    });

    const result = resolveTrust({
      mint: base58(MINT_BYTES),
      attestation: view,
      trustedAttesters: [CREDENTIAL],
      now: NOW,
    });

    assert.equal(result.level, 'attested');
  });

  test('the mint comparison in §5.1 works on the encoded bytes', () => {
    // The attested value is raw bytes and the assessed value is base58, so a
    // consumer has to encode one side. §5.1 says encode the attested bytes.
    const view = toView(roundTrip(payload()), {
      credential: CREDENTIAL,
      expiry: NOW + 86_400,
    });

    const result = resolveTrust({
      mint: base58(Buffer.alloc(32, 8)), // a different mint
      attestation: view,
      trustedAttesters: [CREDENTIAL],
      now: NOW,
    });

    assert.notEqual(result.level, 'attested');
    assert.match(result.conflicts[0], /^mint: /);
  });

  test('an empty optional decodes to undefined, not the empty string', () => {
    // Otherwise findConflicts compares "" against an absent attestation field
    // and reports a conflict that is really just a missing value.
    const view = toView(roundTrip(payload({ subclass: '', issuer_lei: '' })), {
      credential: CREDENTIAL,
      expiry: NOW + 86_400,
    });

    assert.equal(view.subclass, undefined);
    assert.equal(view.issuerLei, undefined);

    const result = resolveTrust({
      mint: base58(MINT_BYTES),
      classification: {
        version: '1',
        assetClass: 'real-estate',
        claim: 'equity',
        subclass: 'multifamily',
        unrecognized: {},
      },
      attestation: view,
      trustedAttesters: [CREDENTIAL],
      now: NOW,
    });

    assert.deepEqual(result.conflicts, []);
  });

  test('expiry read from the account drives the expired level', () => {
    const view = toView(roundTrip(payload()), {
      credential: CREDENTIAL,
      expiry: NOW - 1,
    });

    const result = resolveTrust({
      mint: base58(MINT_BYTES),
      attestation: view,
      trustedAttesters: [CREDENTIAL],
      now: NOW,
    });

    assert.equal(result.level, 'expired');
  });
});
