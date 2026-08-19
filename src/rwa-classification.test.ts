/**
 * Tests for the trust resolver in `rwa-classification.ts`.
 *
 * This is where the spec's security properties actually live — §5.1 (attested
 * vs. unattested), §5.3 (expired vs. absent), §5.6 (metadata/attestation
 * disagreement), and §3's self-attestation detection. Everything else in the
 * module is vocabulary and parsing; this is the part that decides what a user
 * is shown.
 *
 * Run with `npm test` (node:test, native TypeScript stripping, no runner deps).
 */

/// <reference types="node" />

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTrust,
  type AttestationView,
  type Classification,
  type TrustInput,
} from './rwa-classification.ts';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const MINT = 'Rv8nDq4pKmT2xLcYbW6sJ9fHgA3eZuN5tQrX7vMkPd1';
/** A different mint, for the attestation-binding checks. */
const OTHER_MINT = 'Zz3kWq9rNbV5yTxJc2LmH8dGfA6eSuP4tQrX1vMkNe7';
const ATTESTER = 'At7esTerPubKey11111111111111111111111111111';
const ISSUER_AUTHORITY = 'Iss8uerAuthority1111111111111111111111111111';

/** 2026-08-14T00:00:00Z — the spec's own example date. */
const NOW = 1_786_752_000;
const HOUR = 3600;

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    version: '1',
    assetClass: 'real-estate',
    claim: 'equity',
    subclass: 'multifamily',
    jurisdiction: 'US-TX',
    unrecognized: {},
    ...overrides,
  };
}

function attestation(overrides: Partial<AttestationView> = {}): AttestationView {
  return {
    address: 'At7estation111111111111111111111111111111111',
    attester: ATTESTER,
    mint: MINT,
    assetClass: 'real-estate',
    claim: 'equity',
    subclass: 'multifamily',
    jurisdiction: 'US-TX',
    expiresAt: NOW + 30 * 24 * HOUR,
    ...overrides,
  };
}

/** Trusted attester, unexpired, metadata agreeing — the all-green baseline. */
function baseline(overrides: Partial<TrustInput> = {}): TrustInput {
  return {
    mint: MINT,
    classification: classification(),
    attestation: attestation(),
    trustedAttesters: [ATTESTER],
    now: NOW,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

describe('resolveTrust — levels', () => {
  test('trusted, unexpired attester yields "attested"', () => {
    const result = resolveTrust(baseline());

    assert.equal(result.level, 'attested');
    assert.equal(result.attester, ATTESTER);
    assert.equal(result.selfAttested, false);
    assert.deepEqual(result.conflicts, []);
  });

  test('neither metadata nor attestation yields "unknown"', () => {
    const result = resolveTrust({ mint: MINT, trustedAttesters: [ATTESTER], now: NOW });

    assert.equal(result.level, 'unknown');
    assert.equal(result.attester, undefined);
    assert.equal(result.selfAttested, false);
  });

  test('null (not merely absent) inputs also yield "unknown"', () => {
    // Callers hand through RPC misses as null; it must not be treated as a
    // present-but-empty attestation.
    const result = resolveTrust({
      mint: MINT,
      classification: null,
      attestation: null,
      trustedAttesters: [ATTESTER],
      now: NOW,
    });

    assert.equal(result.level, 'unknown');
  });

  test('metadata with no attestation yields "self-declared"', () => {
    const result = resolveTrust(baseline({ attestation: null }));

    assert.equal(result.level, 'self-declared');
    assert.equal(result.attester, undefined);
    assert.ok(result.reasons.includes('no attestation referenced'));
  });

  test('attestation with no metadata still resolves — legacy SPL mints (spec §1)', () => {
    // Layer 2 works standalone, which is how mints that cannot carry
    // additionalMetadata participate at all.
    const result = resolveTrust(baseline({ classification: null }));

    assert.equal(result.level, 'attested');
    assert.deepEqual(result.conflicts, []);
  });

  test('lapsed attestation yields "expired", not "self-declared" (spec §5.3)', () => {
    const result = resolveTrust(
      baseline({ attestation: attestation({ expiresAt: NOW - HOUR }) })
    );

    assert.equal(result.level, 'expired');
    assert.equal(result.attester, ATTESTER);
  });

  test('expiry is exclusive at the boundary — expiresAt === now is expired', () => {
    const result = resolveTrust(baseline({ attestation: attestation({ expiresAt: NOW }) }));

    assert.equal(result.level, 'expired');
  });

  test('one second before expiry is still attested', () => {
    const result = resolveTrust(baseline({ attestation: attestation({ expiresAt: NOW + 1 }) }));

    assert.equal(result.level, 'attested');
  });

  test('now defaults to wall-clock time when omitted', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const input = baseline({ attestation: attestation({ expiresAt: nowSeconds + HOUR }) });
    delete input.now;

    assert.equal(resolveTrust(input).level, 'attested');
  });
});

/* ------------------------------------------------------------------ */
/* Trust set — spec §3.1, consumer policy                              */
/* ------------------------------------------------------------------ */

describe('resolveTrust — trust set', () => {
  test('an untrusted attester carries no more weight than self-declaration', () => {
    // The conservative rule: a valid, unexpired, unrevoked attestation from
    // someone the consumer does not honour buys nothing.
    const result = resolveTrust(baseline({ trustedAttesters: [] }));

    assert.equal(result.level, 'self-declared');
    assert.ok(result.reasons.includes('attester not in trust set'));
  });

  test('the untrusted attester is still reported, so a UI can name it', () => {
    const result = resolveTrust(baseline({ trustedAttesters: ['SomeOtherAttester1111111111111111111111111'] }));

    assert.equal(result.level, 'self-declared');
    assert.equal(result.attester, ATTESTER);
  });

  test('trust is exact-match, not prefix or case-insensitive', () => {
    const result = resolveTrust(baseline({ trustedAttesters: [ATTESTER.toLowerCase()] }));

    assert.equal(result.level, 'self-declared');
  });

  test('an empty trust set never produces "attested"', () => {
    for (const expiresAt of [NOW - HOUR, NOW, NOW + HOUR]) {
      const result = resolveTrust(baseline({ trustedAttesters: [], attestation: attestation({ expiresAt }) }));
      assert.notEqual(result.level, 'attested');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Revocation and precedence                                           */
/* ------------------------------------------------------------------ */

describe('resolveTrust — revocation', () => {
  test('revocation downgrades an otherwise valid attestation', () => {
    const result = resolveTrust(baseline({ attestation: attestation({ revoked: true }) }));

    assert.equal(result.level, 'self-declared');
    assert.ok(result.reasons.includes('attestation revoked'));
  });

  test('revocation outranks expiry — a revoked, lapsed attestation reads as revoked', () => {
    // Precedence matters for the UI copy: "revoked" is an accusation,
    // "expired" is an administrative lapse. They must not be transposed.
    const result = resolveTrust(
      baseline({ attestation: attestation({ revoked: true, expiresAt: NOW - HOUR }) })
    );

    assert.equal(result.level, 'self-declared');
    assert.ok(result.reasons.includes('attestation revoked'));
    assert.ok(!result.reasons.some((r) => r.includes('expired')));
  });

  test('revoked: false is treated as not revoked', () => {
    const result = resolveTrust(baseline({ attestation: attestation({ revoked: false }) }));

    assert.equal(result.level, 'attested');
  });

  test('an untrusted attester short-circuits before expiry is considered', () => {
    // Documents current precedence: trust set is checked before expiry, so a
    // lapsed attestation from an untrusted attester reports "self-declared"
    // rather than "expired".
    const result = resolveTrust(
      baseline({ trustedAttesters: [], attestation: attestation({ expiresAt: NOW - HOUR }) })
    );

    assert.equal(result.level, 'self-declared');
    assert.ok(result.reasons.includes('attester not in trust set'));
  });
});

/* ------------------------------------------------------------------ */
/* Mint binding — an attestation must be about the token being assessed */
/* ------------------------------------------------------------------ */

describe('resolveTrust — mint binding', () => {
  test('an attestation naming a different mint never confers trust', () => {
    // The replay case: a genuine, unexpired, unrevoked attestation from a
    // trusted attester, presented alongside a different token's metadata.
    // Everything about it is valid except the one thing that matters.
    const result = resolveTrust(baseline({ attestation: attestation({ mint: OTHER_MINT }) }));

    assert.notEqual(result.level, 'attested');
    assert.equal(result.level, 'self-declared');
  });

  test('the mismatch is reported rather than silently swallowed', () => {
    const result = resolveTrust(baseline({ attestation: attestation({ mint: OTHER_MINT }) }));

    assert.deepEqual(result.conflicts, [
      `mint: assessed "${MINT}" vs attestation "${OTHER_MINT}"`,
    ]);
    assert.ok(result.reasons.some((r) => r.includes('bound to a different mint')));
  });

  test('a foreign attestation with no metadata leaves nothing to go on', () => {
    // Discarding the attestation means this is indistinguishable from a token
    // that never participated, so "unknown" — not "self-declared", which would
    // imply metadata that does not exist.
    const result = resolveTrust(
      baseline({ classification: null, attestation: attestation({ mint: OTHER_MINT }) })
    );

    assert.equal(result.level, 'unknown');
    assert.equal(result.conflicts.length, 1);
  });

  test('the discarded attester is not named as though it vouched', () => {
    // Leaving `attester` set would let a UI credit an attester that said
    // nothing about this token. The detail stays in `conflicts`.
    const result = resolveTrust(baseline({ attestation: attestation({ mint: OTHER_MINT }) }));

    assert.equal(result.attester, undefined);
    assert.equal(result.selfAttested, false);
  });

  test('binding is checked before the trust set, expiry, and revocation', () => {
    // Otherwise the reported reason would describe the wrong problem: a
    // foreign attestation that is also expired is a binding failure, not a
    // lapsed registration.
    const result = resolveTrust(
      baseline({
        trustedAttesters: [],
        mintAuthorities: [ATTESTER],
        attestation: attestation({ mint: OTHER_MINT, expiresAt: NOW - HOUR, revoked: true }),
      })
    );

    assert.deepEqual(result.reasons, ['attestation is bound to a different mint — disregarded']);
  });

  test('field disagreements are not reported against a foreign attestation', () => {
    // Comparing this token's class against another token's attested class is
    // noise; the only real finding is that the attestation does not apply.
    const result = resolveTrust(
      baseline({
        classification: classification({ assetClass: 'treasury', claim: 'debt-senior' }),
        attestation: attestation({ mint: OTHER_MINT }),
      })
    );

    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0], /^mint: /);
  });

  test('binding is exact-match, not case-insensitive', () => {
    const result = resolveTrust(
      baseline({ attestation: attestation({ mint: MINT.toLowerCase() }) })
    );

    assert.equal(result.level, 'self-declared');
  });

  test('a matching mint is not reported as a conflict', () => {
    const result = resolveTrust(baseline());

    assert.equal(result.level, 'attested');
    assert.deepEqual(result.conflicts, []);
  });
});

/* ------------------------------------------------------------------ */
/* Self-attestation — spec §3                                          */
/* ------------------------------------------------------------------ */

describe('resolveTrust — self-attestation', () => {
  test('an attester that is also a mint authority is flagged but not disqualified', () => {
    // Spec §3: self-attestation is permitted and MUST be detectable, so the
    // consumer can surface or discount it per its own policy.
    const result = resolveTrust(baseline({ mintAuthorities: [ATTESTER] }));

    assert.equal(result.level, 'attested');
    assert.equal(result.selfAttested, true);
    assert.ok(result.reasons.some((r) => r.includes('not independent review')));
  });

  test('an independent attester is not flagged', () => {
    const result = resolveTrust(baseline({ mintAuthorities: [ISSUER_AUTHORITY] }));

    assert.equal(result.selfAttested, false);
  });

  test('the flag survives a downgrade to self-declared', () => {
    // A revoked self-attestation must still read as self-attested; losing the
    // flag on downgrade would hide the shell-attester pattern in spec §7.
    const result = resolveTrust(
      baseline({ mintAuthorities: [ATTESTER], attestation: attestation({ revoked: true }) })
    );

    assert.equal(result.level, 'self-declared');
    assert.equal(result.selfAttested, true);
  });

  test('the flag survives expiry', () => {
    const result = resolveTrust(
      baseline({ mintAuthorities: [ATTESTER], attestation: attestation({ expiresAt: NOW - HOUR }) })
    );

    assert.equal(result.level, 'expired');
    assert.equal(result.selfAttested, true);
  });

  test('any one of several mint authorities matching is enough', () => {
    const result = resolveTrust(baseline({ mintAuthorities: [ISSUER_AUTHORITY, ATTESTER] }));

    assert.equal(result.selfAttested, true);
  });

  test('omitting mintAuthorities cannot detect self-attestation', () => {
    // Callers that skip the authority fetch get false, not a crash — but they
    // also get no detection, which is worth stating explicitly.
    const result = resolveTrust(baseline());

    assert.equal(result.selfAttested, false);
  });
});

/* ------------------------------------------------------------------ */
/* Conflicts — spec §5.6, tamper signal                                */
/* ------------------------------------------------------------------ */

describe('resolveTrust — conflicts', () => {
  test('a metadata repoint is surfaced without silently preferring either side', () => {
    // Spec §7: the update authority can rewrite Layer 1 at any time. The
    // attestation is the fixed point that makes it detectable.
    const result = resolveTrust(
      baseline({ classification: classification({ assetClass: 'treasury' }) })
    );

    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0], /^class: metadata "treasury" vs attestation "real-estate"$/);
    assert.ok(result.reasons.includes('metadata disagrees with attestation'));
  });

  test('a conflict does not by itself revoke "attested"', () => {
    // The spec says flag, not override — the consumer decides what to do.
    const result = resolveTrust(
      baseline({ classification: classification({ assetClass: 'treasury' }) })
    );

    assert.equal(result.level, 'attested');
  });

  test('claim is compared independently of class', () => {
    // The orthogonality argument in §2.2: a mortgage note and an equity stake
    // in the same building share a class and must not be conflated.
    const result = resolveTrust(
      baseline({ classification: classification({ claim: 'debt-senior' }) })
    );

    assert.deepEqual(result.conflicts, ['claim: metadata "debt-senior" vs attestation "equity"']);
  });

  test('every comparable field is checked', () => {
    const result = resolveTrust(
      baseline({
        classification: classification({
          assetClass: 'treasury',
          claim: 'debt-senior',
          subclass: 'office',
          jurisdiction: 'GB',
          issuerLei: '5493001KJTIIGC8Y1R12',
        }),
        attestation: attestation({ issuerLei: '213800WAVVOPS85N2205' }),
      })
    );

    assert.equal(result.conflicts.length, 5);
    for (const field of ['class', 'claim', 'subclass', 'jurisdiction', 'issuer_lei']) {
      assert.ok(
        result.conflicts.some((c) => c.startsWith(`${field}: `)),
        `expected a conflict for ${field}, got ${JSON.stringify(result.conflicts)}`
      );
    }
  });

  test('a field absent from metadata is not a conflict', () => {
    const result = resolveTrust(
      baseline({ classification: classification({ jurisdiction: undefined }) })
    );

    assert.deepEqual(result.conflicts, []);
  });

  test('a field absent from the attestation is not a conflict', () => {
    const result = resolveTrust(
      baseline({ attestation: attestation({ subclass: undefined }) })
    );

    assert.deepEqual(result.conflicts, []);
  });

  test('conflicts are computed even when the level is downgraded', () => {
    const result = resolveTrust(
      baseline({
        trustedAttesters: [],
        classification: classification({ assetClass: 'treasury' }),
      })
    );

    assert.equal(result.level, 'self-declared');
    assert.equal(result.conflicts.length, 1);
  });

  test('no attestation means nothing to conflict against', () => {
    const result = resolveTrust(baseline({ attestation: null }));

    assert.deepEqual(result.conflicts, []);
  });
});

/* ------------------------------------------------------------------ */
/* Reporting contract                                                  */
/* ------------------------------------------------------------------ */

describe('resolveTrust — reporting', () => {
  test('every outcome carries at least one reason', () => {
    const cases: TrustInput[] = [
      { mint: MINT, trustedAttesters: [] },
      baseline(),
      baseline({ attestation: null }),
      baseline({ trustedAttesters: [] }),
      baseline({ attestation: attestation({ expiresAt: NOW - HOUR }) }),
      baseline({ attestation: attestation({ revoked: true }) }),
      baseline({ attestation: attestation({ mint: OTHER_MINT }) }),
    ];

    for (const input of cases) {
      const result = resolveTrust(input);
      assert.ok(
        result.reasons.length > 0,
        `expected a reason for level "${result.level}"`
      );
    }
  });

  test('the expiry reason names the actual expiry time', () => {
    const expiresAt = NOW - HOUR;
    const result = resolveTrust(baseline({ attestation: attestation({ expiresAt }) }));

    assert.ok(
      result.reasons.some((r) => r.includes(new Date(expiresAt * 1000).toISOString())),
      `expected an ISO timestamp in ${JSON.stringify(result.reasons)}`
    );
  });

  test('the conflict reason precedes the level reason', () => {
    // Ordering is part of the contract: a UI rendering reasons in order should
    // lead with the tamper signal, not bury it under the happy path.
    const result = resolveTrust(
      baseline({ classification: classification({ assetClass: 'treasury' }) })
    );

    assert.equal(result.reasons[0], 'metadata disagrees with attestation');
  });

  test('resolveTrust does not mutate its inputs', () => {
    const input = baseline({ mintAuthorities: [ATTESTER] });
    const snapshot = structuredClone(input);

    resolveTrust(input);

    assert.deepEqual(input, snapshot);
  });
});
