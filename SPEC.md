# DRAFT: sRFC XX: RWA Asset Classification and Data Discovery

- **Status:** Draft — unnumbered, seeking comment
- **Discussion:** [solana-foundation/SRFCs](https://github.com/solana-foundation/SRFCs/discussions)
- **Repository:** <https://github.com/pzupan/rwa-classification>
- **Author:** pzupan (ioniqx) — *co-sponsors sought, see "Governance"*
- **Created:** 2026-08-14
- **Extends:** [sRFC 00020: RWA/Security Token Standard](https://forum.solana.com/t/srfc-00020-rwa-security-token-standard/370)
- **Builds on:** [sRFC 00017: Token Metadata Interface](https://forum.solana.com/t/srfc-00017-token-metadata-interface/283), Token-2022 Metadata extension, [Solana Attestation Service](https://attest.solana.com/)

## Summary

A minimal, jurisdiction-agnostic convention for declaring **what real-world asset
a token represents**, **what claim the holder has on it**, and **where to find
the extended data** — bound to an expiring on-chain attestation so the
declaration is verifiable rather than merely asserted.

This proposal deliberately does **not** specify transfer compliance mechanics.
That is sRFC 00020's subject, and this is designed to sit alongside it.

## Motivation

There is today no way for a wallet, indexer, or aggregator to determine that a
Solana mint represents real estate — or any other asset class — without
per-issuer bespoke integration.

sRFC 00020 covers permissioning, clawback, trading halts, and distributions. When
classification came up in that thread, the resolution was that issuers should
self-declare their asset type and implement matching logic. That is workable for
an issuer's own product surface and unworkable for anyone consuming tokens they
did not issue, because a self-declared string with no attestation is trivially
spoofed. Any wallet that renders it as authoritative becomes a phishing surface:
minting a token named `RVBND` with matching metadata costs a few cents.

Consumers currently fall back to name/symbol heuristics (unsafe), curated
allowlists (unscalable, and each wallet maintains its own), or third-party
aggregators (editorial, high-latency, poor small-issuer coverage).

The missing pieces are narrow: a small shared vocabulary, and a binding from that
vocabulary to someone accountable.

## Non-goals

Scope discipline is the main lesson from 00020's stall. Explicitly out of scope:

1. **Transfer compliance and permissioning.** See sRFC 00020.
2. **NAV, valuation, and price oracles.** The discussion in 00020 foundered here.
   This spec names *where* a NAV feed lives; it does not specify its integrity,
   cadence, or dispute resolution.
3. **Exhaustive property schemas.** Real estate has hundreds of relevant fields.
   None belong on-chain. They live behind discovery (§4).
4. **Legal effect.** Nothing here asserts that a token conveys title. A
   classification is a *description*, not a conveyance.
5. **Identity/KYC of holders.** SAS already covers this.

## 1. Layer overview

| Layer | Location | Mutable by | Trust |
|---|---|---|---|
| 1. Classification | Token-2022 `additionalMetadata` on the mint | Metadata update authority | Self-declared |
| 2. Attestation | Solana Attestation Service | Attester (expiring; §3.4) | Verified |
| 3. Discovery | Off-chain, signed + hash-pinned | Issuer | Mixed, see §4 |

Layer 1 alone is a convenience. **Layer 1 without Layer 2 MUST NOT be presented
as verified** (§5). Layer 2 works standalone, which is how legacy SPL Token mints
that cannot carry `additionalMetadata` participate.

## 2. Layer 1 — classification fields

Keys are namespaced `rwa.*` to avoid collision with existing conventions.

| Key | Req. | Value |
|---|---|---|
| `rwa.v` | REQUIRED | Spec version. `1` for this document. |
| `rwa.class` | REQUIRED | Closed enum, §2.1 |
| `rwa.claim` | REQUIRED | Closed enum, §2.2 |
| `rwa.jurisdiction` | RECOMMENDED | ISO 3166-1 alpha-2, or 3166-2 where subdivision is material (`US-TX`) |
| `rwa.issuer_lei` | RECOMMENDED | ISO 17442 LEI of the issuing entity or SPV |
| `rwa.attestation` | OPTIONAL | Hint only; the address is derivable without it (§3.3) |
| `rwa.subclass` | OPTIONAL | Open registry, §2.3 |
| `rwa.api` | OPTIONAL | HTTPS URL of the discovery document (§4) |

Three required keys. Consumers MUST ignore unrecognized `rwa.*` keys rather than
rejecting the token, so the vocabulary can grow without breaking readers.

### 2.1 `rwa.class` — what the asset is

Closed set. An open set is unfilterable and therefore useless for the routing and
grouping decisions consumers need to make.

```
real-estate  treasury      corporate-credit  private-credit
public-equity  private-equity  commodity     fund
carbon       receivable    other
```

Anything unlisted uses `other` plus a `rwa.subclass`. Additions to this set
require a spec version bump.

### 2.2 `rwa.claim` — what the holder owns

Closed set. **This axis is orthogonal to `rwa.class` and omitting it is the most
common failure in naive taxonomies.**

```
equity           preferred-equity  debt-senior     debt-mezzanine
fund-lp          revenue-share     direct-title    derivative
```

A first-lien mortgage note secured by an apartment building and an equity stake
in that same building are both `real-estate`, with inverted risk profiles,
opposite behaviour in a downturn, and different regulatory treatment. A consumer
that buckets them together on the strength of `rwa.class` alone actively
misleads its users. Both fields are required so this cannot be skipped.

`direct-title` is reserved for tokens where the token itself is the instrument of
title under some jurisdiction's law. It is expected to be rare and SHOULD carry an
attestation naming the recording authority.

### 2.3 `rwa.subclass` — open registry

Extensible, maintained as a flat list in the reference repository, additions by
PR without a version bump. For `real-estate`, the initial vocabulary aligns with
the NCREIF/NAREIT core property types rather than inventing one:

```
multifamily  industrial  office     retail        hospitality
self-storage data-center senior-housing  single-family-rental
land         mixed-use   specialty
```

### 2.4 Property identification

Property identifiers are **not** carried in Layer 1. They are jurisdictional
(US county APN, UK UPRN, FR cadastre) and they are a privacy hazard: a public
parcel ID joined against public token balances and public property records
deanonymizes a holder's position and, by extension, their net worth.

Where a property reference is needed it appears in the attestation (§3) as a
commitment:

```
property_commit = sha256(namespace || ":" || identifier || salt)
```

with `namespace` drawn from a registry of the form `us-tx-travis-apn`, `gb-uprn`,
`fr-cadastre`. The preimage is disclosed off-chain to parties with standing —
regulators, auditors, holders under NDA — not to chain observers.

## 3. Layer 2 — attestation

Layer 2 uses the Solana Attestation Service (program
`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`, Apache-2.0, maintained by the
Solana Foundation). No new program is required or proposed. Field encodings below
are pinned against `sas-lib@1.0.10` and verified end-to-end on devnet (§3.6).

A **Credential** identifies the attesting authority — a transfer agent, auditor,
regulated registry, or exchange. A **Schema** named `rwa.classification.v1`
defines the claim. An **Attestation** binds a mint to a classification.

### 3.1 Schema layout

A SAS `Schema` account stores `fieldNames` alongside a `layout` byte array, one
compact type code per field. The codes are the SDK's, not this spec's; the
relevant subset is `12` = `String` and `13` = `Vec<u8>`. Attestation data is
Borsh-encoded against the struct those two arrays describe.

`rwa.classification.v1` is exactly:

| # | Field | Code | Borsh type | Contents |
|---|---|---|---|---|
| 0 | `mint` | 13 | `Vec<u8>` | 32 raw bytes. Subject of the claim (§5.1) |
| 1 | `class` | 12 | `String` | MUST match §2.1 |
| 2 | `claim` | 12 | `String` | MUST match §2.2 |
| 3 | `subclass` | 12 | `String` | MAY be empty |
| 4 | `jurisdiction` | 12 | `String` | ISO 3166 |
| 5 | `issuer_lei` | 12 | `String` | ISO 17442, MAY be empty |
| 6 | `property_commit` | 13 | `Vec<u8>` | §2.4. 32 bytes, or empty if unused |
| 7 | `discovery_url` | 12 | `String` | Canonical §4 pointer |
| 8 | `discovery_signer` | 13 | `Vec<u8>` | 32 raw bytes. Signs the §4 document |

Field order is normative — Borsh is positional, and `layout` carries no names of
its own beyond the parallel `fieldNames` array.

**Pubkeys are 32 raw bytes, not base58 strings.** SAS has no pubkey type code, so
a key has to be carried as either `Vec<u8>` or `String`. This spec picks raw
bytes: it is canonical, it is half the size, and it removes base58 as a place
where two implementations can disagree. Consumers comparing against a base58
address MUST encode the attested bytes rather than decoding the address, so that
a malformed value fails the comparison instead of throwing.

**`Vec<u8>` is length-prefixed.** A 32-byte value occupies 36 bytes on the wire.
`property_commit` is the one field that MAY be empty rather than zero-filled;
prefer empty, since 32 zero bytes is a valid-looking commitment to nothing.

A fully populated attestation serializes to 228 bytes.

### 3.2 Expiry is the account's, not the schema's

**`expires_at` is deliberately absent from the schema.** The SAS `Attestation`
account already carries a native `expiry` field, set through the
`createAttestation` instruction. Carrying a second copy inside the Borsh payload
would create two sources of truth that can disagree, with no rule for which
wins — and the native one is the only one the program itself can enforce.
Consumers MUST read expiry from the account.

**Expiry is mandatory.** Appraisals go stale, SPVs dissolve, transfer agents get
replaced, registrations lapse. An attestation without expiry is a claim about the
past presented as a claim about the present.

### 3.3 Discovery without an indexer

The `Attestation` PDA derives from `(credential, schema, nonce)`, where `nonce`
is free-form. This spec fixes **`nonce` = the subject mint**.

That one choice makes attestations discoverable by derivation rather than
search. A consumer holding a trust set already knows each attester's credential,
and the schema PDA follows from it, so for any mint it can compute the exact
attestation address and fetch it — one derivation and one account read per
trusted attester, with no indexer, no log scanning, and no dependence on
`rwa.attestation` being present or honest.

It follows that `rwa.attestation` (§2) is a convenience hint, never the
authority: it is written by the same update authority as the rest of Layer 1.
A consumer MUST NOT trust an attestation solely because Layer 1 pointed at it.

This also resolves how legacy SPL Token mints participate. They cannot carry
`additionalMetadata`, but they need no pointer — the derivation is over the mint
address, which every token has.

### 3.4 Revocation is deletion, and that has consequences

SAS has no `revokeAttestation` instruction. Revocation is `closeAttestation`,
which **deletes the account** and emits a `CloseAttestationEvent` carrying the
data that was destroyed.

This is worth stating plainly because it defeats the obvious reading of §5.4: to
a consumer reading accounts, a revoked attestation and one that never existed are
byte-for-byte identical. Only a party consuming program logs can tell them apart,
and logs age out of most RPC providers.

Consequently:

1. Expiry, not revocation, is the load-bearing control. Attestations SHOULD be
   issued with short lifetimes and re-issued, so that withdrawal of an attester's
   opinion takes effect by lapse rather than requiring a positive act.
2. Consumers SHOULD NOT model revocation as a state distinct from absence unless
   they index `CloseAttestationEvent`. A reader that offers a "revoked" display
   state it can never populate from account data is lying about its coverage.
3. `changeSchemaStatus` sets `isPaused` on the whole schema — a kill switch for
   every attestation under it at once. Consumers SHOULD check it, and MUST treat
   a paused schema as no better than unattested.
4. **Renewal also closes.** Fixing the nonce (§3.3) fixes the address, and SAS
   will not create over a live account, so re-issuing an attestation means
   `closeAttestation` followed by `createAttestation` on the same address.
   Attesters SHOULD put both in one transaction, so the mint never reads as
   unattested between them. A consumer that indexes `CloseAttestationEvent`
   MUST NOT treat a close followed in the same transaction by a create at the
   same address as a revocation; it is a re-issue, and every routine renewal
   produces one.

Lifetimes are attester policy, not fixed here. As a guide: a classification
attestation SHOULD NOT exceed 90 days, since the asset facts behind it go stale
and expiry is the only withdrawal a reader is guaranteed to see. Standing and
binding attestations (§3.8, §3.9) MAY run longer — a year is typical, matching
KYB review cycles — because the consumer rules for both require the account to
exist, so closing one withdraws it as soon as a reader re-reads.

### 3.5 Attester identity

The `Attestation` account carries both `credential` and `signer`. They are not
interchangeable: `signer` is whichever of the credential's `authorizedSigners`
signed this particular attestation, and that set is rotatable at will via
`changeAuthorizedSigners`.

**Trust sets are keyed on the credential**, which is the stable identity of the
attesting organisation. `signer` is operational detail, useful for forensics and
useless for policy — keying trust on it means a routine key rotation silently
invalidates every attestation an attester has issued.

**The attester SHOULD NOT be the issuer.** An issuer attesting to its own
classification adds a signature but no independent verification. Self-attestation
is permitted and MUST be detectable — consumers compare the credential authority
and `signer` against the mint's authorities — so it can be surfaced or discounted
per consumer policy.

That comparison only works while the issuer signs with its own keys. A
tokenization platform commonly holds the mint authority in custody (an HSM, a
key-management service, or a multisig vault) while attesting under a
credential whose authority is a different platform key. The keys then differ
even though one organisation controls both, and the check passes. Such a
platform counts as the issuer for the purposes of this section. Consumers
SHOULD NOT treat differing keys alone as evidence of independence; independent
verification shows up as a standing attestation (§3.8) from a party other than
the platform.

### 3.6 Reference deployment

A working schema exists on devnet, created by `npm run sas:devnet`:

| Account | Address |
|---|---|
| Credential | `5Es4gSTWYemJxPMkWGYAi56Xzf2cSosJBRMaQaVVuxZq` |
| Schema | `ASE1gwae1gBPZctkdNXdyGJcmqwPMVW9iMHqs22bJa9p` |
| Example attestation | `G6qArVxuNwL9aC3EpTY443TfVTfyFmKwQhgmnd6rht9b` |

This is a draft artifact for implementers to read against, not a trust root and
not a mainnet registration. It covers `rwa.classification.v1` only; the
`rwa.issuer.v1` and `rwa.lei.v1` drafts (§3.8, §3.9) have no reference
deployment here yet. Adoption-bar item 2 (§9) means a mainnet schema under
a credential that is not solely the author's.

### 3.7 Trust sets are not part of this spec

This document does not name trusted attesters and does not establish a registry.
Which attesters a consumer honours is consumer policy, and any list SHOULD be
independently forkable. A specification that appoints its own authors as the
trust root would not deserve adoption.

### 3.8 Issuer standing — `rwa.issuer.v1` (draft)

A platform that tokenizes for many issuers typically classifies each issuer's
mints under a **per-issuer classification credential**. Trusting each of those
directly does not scale, and trusting the platform's one credential cannot
withdraw a single issuer. An issuer-standing attestation lets any third party —
a KYB provider, transfer agent, auditor, or the platform itself — vouch for one
classification credential, and withdraw that one alone by closing it (§3.4).

For a platform this is the primary trust path, not an extension: consumers
cannot enumerate per-issuer credentials (SAS derives each from its authority
and a name of the platform's choosing) and SHOULD NOT be asked to. They trust a
handful of standing attesters, and reach each issuer's credential through
them:

```
mint ── rwa.classification.v1, under the issuer's credential
         └── issuer's credential ── rwa.issuer.v1, under each standing attester
```

A platform SHOULD NOT classify every issuer's mints under one shared
credential. Withdrawing that credential's standing withdraws every issuer at
once, and leaving it in place keeps a withdrawn issuer's mints Verified.

Registered by any attester under its own credential:

| Name | Version | Nonce |
|---|---|---|
| `rwa.issuer.v1` | `1` | the classification credential vouched for |

| # | Field | Type code | Type | Notes |
|---|---|---|---|---|
| 0 | `classification_credential` | 13 | `Vec<u8>` | 32 bytes; equal to the nonce |
| 1 | `attester_name` | 12 | `String` | legal name of the party issuing this attestation |
| 2 | `attester_lei` | 12 | `String` | ISO 17442 LEI of that party, MAY be empty |
| 3 | `subject_name` | 12 | `String` | legal name of the issuer that owns the credential |
| 4 | `subject_lei` | 12 | `String` | ISO 17442, MAY be empty |
| 5 | `subject_jurisdiction` | 12 | `String` | ISO 3166-1/-2, MAY be empty |
| 6 | `verified_at` | 8 | `i64` | Unix seconds the attester completed its review |

Layout: `[13, 12, 12, 12, 12, 12, 8]`.

**`attester_name` identifies who vouched, so a consumer can say so** ("Verified by
…"). It is the attester's own statement about itself, and carries weight only
because the consumer chose to trust the credential it is written under (§3.5):
the trust decision is keyed on the credential, the name is for display and audit.

**Consumer rule.** A consumer holding a set of trusted *issuer-standing*
credentials treats a classification credential C as trusted when at least one
attestation exists with nonce C, under a trusted credential, under an unpaused
`rwa.issuer.v1` schema of that credential, that has not expired. Several
attesters MAY vouch for the same C; a consumer SHOULD show each, and one closing
its attestation leaves the others standing. This extends §3.7, it does not
replace it: which issuer-standing credentials to honour is itself consumer
policy, and a consumer MAY still trust classification credentials directly.

Nothing in this schema gates a transfer (§5.3).

### 3.9 LEI binding — `rwa.lei.v1` (draft)

`issuer_lei` (§3.1) and `subject_lei` (§3.8) are claims about an entity; nothing
in them says anyone checked. A **LEI binding** is an attester's statement that it
verified the legal entity holding an ISO 17442 LEI (its own KYB, or a vLEI
presentation), and optionally which classification credential that entity issues
under. A platform onboarding an issuer that already has one MAY rely on it in
place of repeating entity verification, per its own policy.

It does not create or certify an LEI. LEIs are issued by GLEIF-accredited LOUs
and their status lives at GLEIF; the binding records what GLEIF said when the
attester checked, and a consumer that cares about the LEI's current status
SHOULD ask GLEIF (§11).

Registered by any attester under its own credential:

| Name | Version | Nonce |
|---|---|---|
| `rwa.lei.v1` | `1` | `sha256("rwa.lei.v1:" ‖ LEI)` — the 20-character LEI, uppercase ASCII |

The nonce is a hash, not a key anyone holds; SAS derives the PDA from any 32
bytes. Given an LEI and a set of trusted credentials, a consumer derives every
account to read, with no indexer (as §3.3 does for mints).

| # | Field | Type code | Type | Notes |
|---|---|---|---|---|
| 0 | `lei` | 12 | `String` | the LEI; MUST hash to the nonce |
| 1 | `legal_name` | 12 | `String` | the entity's legal name as GLEIF records it |
| 2 | `jurisdiction` | 12 | `String` | GLEIF's legal jurisdiction, ISO 3166-1/-2, MAY be empty |
| 3 | `registration_status` | 12 | `String` | GLEIF `registration.status` at verification, e.g. `ISSUED` |
| 4 | `classification_credential` | 13 | `Vec<u8>` | 32 bytes, or empty if the entity issues under none yet |
| 5 | `attester_name` | 12 | `String` | legal name of the party issuing this attestation |
| 6 | `attester_lei` | 12 | `String` | ISO 17442 LEI of that party, MAY be empty |
| 7 | `basis` | 12 | `String` | how the entity was verified: `kyb`, `vlei`, or another registered value |
| 8 | `verified_at` | 8 | `i64` | Unix seconds the attester completed its verification |

Layout: `[12, 12, 12, 12, 13, 12, 12, 12, 8]`.

**Attesters MUST set an expiry** no later than the LEI's GLEIF `nextRenewalDate`
where that is sooner than the attester's own re-verification period, so a binding
never outlives the registration it describes. A consumer MUST treat an expiry of
`0` as expired.

**Consumer rule.** A consumer holding a set of trusted *LEI-binding* credentials
treats LEI L as verified when an unexpired attestation with nonce
`sha256("rwa.lei.v1:" ‖ L)` exists under a trusted credential and an unpaused
`rwa.lei.v1` schema of that credential, and its `lei` field equals L. A consumer
relying on it for onboarding SHOULD also confirm with GLEIF that L is `ISSUED`,
that its entity status is `ACTIVE`, and that its legal name matches the entity
in front of it. An LEI that is in good standing but names someone else is not
that entity's, whoever attested it. Attesters SHOULD apply the same three
checks before writing a binding. Which LEI-binding credentials to honour is
consumer policy (§3.7), and a consumer MUST NOT count its own credential as an
independent verification of an entity it is onboarding.

Nothing in this schema gates a transfer (§5.3).

## 4. Layer 3 — data discovery and integrity

Extended property data cannot live on-chain. `rwa.api` points to a **discovery
document**, not a live data endpoint:

```
https://issuer.example/.well-known/rwa/<mint>.json
```

One document per mint, at a path keyed by the base58 mint address, because the
document names a single `mint` (§4.2) and the attestation that pins its signer
is per mint (§3.1). An issuer with many mints serves many documents from one
host.

Static, cacheable, CORS-enabled, and it names the actual endpoints. This
indirection matters because updating mint metadata costs an authority action and
rent, so a URL written directly into a mint will go stale and stay stale.

### 4.1 Signing: detached, over raw bytes

The document is served with a detached ed25519 signature at
`.well-known/rwa/<mint>.sig`, computed over **the exact bytes of
`<mint>.json` as served**.

A consumer MUST check that the document's `mint` equals the mint it is
assessing, for the same reason §5.1 requires it of attestations: a validly
signed document for one mint is no evidence about another.

Raw-byte signing is deliberate. Signing a canonicalized JSON structure (JCS or
otherwise) introduces a canonicalization implementation on both sides and every
divergence between them is a signature bypass. Detached-over-bytes has no such
surface.

The signing key MUST match `discovery_signer` in the attestation. **TLS is not
sufficient.** TLS proves the reader reached the domain; it says nothing about who
authored the content. If an issuer folds and its domain lapses, the re-registrant
obtains a valid certificate and can serve authoritative-looking data for a live
mint. A signature bound to an on-chain attested key cannot be re-acquired with
the domain.

### 4.2 Document shape

```json
{
  "version": "1",
  "mint": "Rv8nDq4pKmT2xLcYbW6sJ9fHgA3eZuN5tQrX7vMkPd1",
  "issuedAt": "2026-08-14T00:00:00Z",
  "expiresAt": "2026-11-14T00:00:00Z",
  "manifest": "bafkrei...",
  "endpoints": {
    "summary":   "https://api.issuer.example/v1/assets/Rv8n.../summary",
    "documents": "https://api.issuer.example/v1/assets/Rv8n.../documents",
    "nav":       "https://api.issuer.example/v1/assets/Rv8n.../nav"
  }
}
```

`manifest` is a multihash over the pinned document set (offering memorandum,
appraisal, insurance certificate, SPV formation docs), which SHOULD also be
content-addressed on IPFS or Arweave. Anything fetched that does not hash into
the manifest is unverified and MUST be presented as such.

### 4.3 Data classes by cadence

| Data | Transport | Integrity |
|---|---|---|
| Deed reference, SPV, jurisdiction, property commit | Attestation | Attested, expiring |
| Offering docs, appraisals, imagery | Content-addressed, hash in manifest | Tamper-evident |
| NAV, occupancy, distribution history | Live endpoint | **Unverified**, display-only |

Live data MUST NOT feed authorization decisions and MUST be displayed with an
"as of" timestamp.

Endpoint payloads are the issuer's to define. A shape that has worked in
practice, offered as a non-normative starting point, puts a common envelope on
every response:

```json
{
  "version": "1",
  "mint": "Rv8nDq4pKmT2xLcYbW6sJ9fHgA3eZuN5tQrX7vMkPd1",
  "asOf": "2026-10-09T12:00:00Z",
  "verified": false,
  "navPerToken": "1.0425",
  "struckAt": "2026-09-30T00:00:00Z"
}
```

`verified: false` states in the payload itself that it carries no integrity of
its own. Amounts are decimal strings, so no reader parses money through a
float. A NAV that is struck only at events such as redemptions SHOULD say when
it was struck rather than present itself as current. What an endpoint may
expose at all is subject to §8.

## 5. Consumer requirements (normative)

A conforming consumer:

1. **MUST** check that an attestation's `mint` is the mint being assessed before
   relying on it. An attestation naming a different mint is not weak evidence
   about this token, it is no evidence about this token, and it MUST be
   disregarded rather than surfaced as a disagreement per §5.7. Without this
   check any genuine attestation can be replayed against any mint, which makes
   Layer 2 worth less than nothing: it converts an attester's reputation into a
   spoofing primitive. Note that `rwa.attestation` (§2) is written by the same
   authority as the rest of Layer 1 and so cannot itself establish the binding.
2. **MUST NOT** present unattested Layer 1 classification with the same visual
   treatment as attested classification.
3. **MUST NOT** use any field in this spec for authorization, transfer
   eligibility, or compliance decisions. Those are enforced on-chain by the
   token's own extensions. This spec is descriptive.
4. **MUST** distinguish *expired attestation* from *no attestation*. They mean
   different things: one issuer lapsed, the other never participated. Note that
   *revoked* is not a third state available to account readers (§3.4).
5. **MUST** display an "as of" timestamp on live-endpoint data.
6. **SHOULD** fetch discovery lazily — on a detail view, not on portfolio load.
   Eager fetching broadcasts a user's entire position set to every issuer whose
   tokens they hold, every time they open the wallet (§6).
7. **SHOULD** flag disagreement between `rwa.*` metadata and the attestation as a
   tamper signal rather than silently preferring one.

## 6. Privacy considerations

**Parcel join.** Covered in §2.4. This is the reason real estate warrants a
profile of its own rather than folding into a generic RWA classification: no
other asset class has a public, government-maintained, address-keyed registry
sitting on the other side of the join.

**Discovery phone-home.** Fetching an issuer-controlled URL discloses the
reader's IP, which mint they hold, and when they looked. Across several issuers
this reconstructs a portfolio. Mitigations, in preference order: lazy fetch (§5.6);
fetch via an indexer or proxy, which reduces N observers to one with a stated
policy rather than eliminating the disclosure; cache aggressively.

Browser-extension wallets should note that fetching arbitrary issuer origins
requires broad MV3 host permissions, which is both a review burden and a genuine
attack-surface expansion.

## 7. Security considerations

- **Domain lapse / takeover** — §4.1, mitigated by attested detached signing.
- **Metadata repoint** — the update authority can rewrite Layer 1 at any time.
  Detected by comparing against the attestation (§5.7).
- **Attester compromise** — bounded by expiry, since revocation is unobservable
  to account readers (§3.4). Consumers should support fast trust-set removal,
  which is the only mitigation fully under their own control.
- **Self-attestation laundering** — an issuer standing up a shell attester.
  Detectable only through attester diligence; the spec makes attester identity
  legible (LEI, credential authority) so that diligence is possible.
- **Attestation replay** — presenting a valid attestation issued for one mint
  alongside a different mint's metadata. The attestation's `mint` field is the
  binding; §5.1 makes checking it mandatory.
- **Enum squatting** — mitigated by the closed `rwa.class` set.

## 8. Securities-law considerations (non-normative)

This section is informational. It does not impose conformance requirements on
consumers and does not change any Layer 1–3 mechanics. It exists because the
same discoverability that makes this standard useful — a mint's classification
being derivable by any observer without an indexer (§3.3) — sits close to a
line that some issuers are legally required not to cross, and an implementer
reading only the mechanical sections could wire the discovery layer in a way
that creates an offering-law problem the spec itself never intended.

Nothing in this document is legal advice. Issuers are responsible for their own
exemption analysis and should obtain their own counsel's approval before
publishing conforming metadata for a live offering.

### 8.1 The classification layers are descriptive, not an offer

Layers 1 and 2 describe **what an asset is** and **what claim a holder has on
it**. They are deliberately incapable of carrying price, availability,
minimum investment, projected return, valuation, or any term of an offering —
none of those fields exist in §2 or §3.1, and none should be smuggled into
`rwa.subclass`, a discovery URL, or an unrecognized `rwa.*` key.

This is a design property with a legal consequence. Under U.S. law, an
exemption from registration under Regulation D that relies on Rule 506(b)
requires the issuer to avoid "general solicitation or general advertising"
(Securities Act Rule 502(c)). The prohibition targets the *offering
communication* — the pitch, its terms, anything that conditions the public mind
or arouses interest in the securities — not the mere on-chain existence or
discoverability of a security. A classification is a description, not a
conveyance (§Non-goals) and not an offer. Keeping the on-chain layers purely
classificatory is what keeps discoverability on the descriptive side of that
line.

The equivalent line is well-worn off-chain: an issuer's public website may
carry factual business information but not offering terms, projections, or
performance data, while the offering material itself sits behind a gated,
relationship-based channel. Layers 1–2 are the public site; Layer 3 is the
gate.

### 8.2 Layer 3 is the issuer's responsibility, at the issuer's exemption

The discovery document (`rwa.api`, §4) and everything it points to — offering
memoranda, appraisals, NAV endpoints, subscription materials — are **issuer
content governed by the issuer's chosen exemption**, not by this spec. The spec
specifies only *where* the pointer lives and *how* its integrity is proven
(§4.1); it says nothing about who may read the content behind it, and it must
not be read as permission to serve offering material to the public.

An issuer relying on Rule 506(b) SHOULD ensure that offering material behind
`rwa.api` is not accessible to persons with whom the issuer lacks a
pre-existing, substantive relationship, and that the publicly fetchable
discovery document itself (the `.well-known/rwa/<mint>.json` and its endpoint
*names*) carries no offering terms. Gating the *content* while leaving the
*pointer* public is consistent with the spec: the pointer is classification
infrastructure; the content is the offering.

An issuer relying on Rule 506(c), which permits general solicitation to
verified accredited investors, has more latitude in what Layer 3 may expose,
but assumes the corresponding obligation to take reasonable steps to verify
accredited status before sale. Note that the attestation primitive this spec
builds on (§3) is the same class of mechanism that the SEC staff has
recognized may be used to obtain and evidence the accredited-investor and
non-financing representations that support the streamlined 506(c) verification
approach — though this spec's `rwa.classification.v1` schema is not itself an
eligibility attestation and MUST NOT be repurposed as one. Eligibility and
identity are SAS's domain and the token's own transfer logic (sRFC 00020), not
this classification schema.

### 8.3 The standard is exemption-neutral by construction

This document takes no position on which exemption an issuer uses, or on
whether a given token is even offered in the United States. That neutrality is
intentional and is the reason `rwa.jurisdiction` is a hint for consumers rather
than a control, and the reason no field encodes offering status. A consumer
MUST NOT infer from the presence of conforming metadata that a token is being
lawfully offered in the consumer's jurisdiction, that it is available for
purchase, or that any exemption is available to the reader — the metadata
describes the instrument, not the reader's ability to acquire it.

### 8.4 Summary of issuer obligations

An issuer publishing conforming metadata for a security:

- MUST NOT place price, availability, minimum investment, projected or
  historical return, valuation, or any offering term in any Layer 1 or Layer 2
  field, or in the publicly fetchable body of the Layer 3 discovery document.
- MUST treat Layer 3 offering content as governed by its own exemption, and
  gate access to it accordingly — for a 506(b) offering, behind a
  pre-existing substantive relationship; for a 506(c) offering, subject to
  accredited-investor verification before sale.
- MUST NOT rely on this spec, or on the discoverability it enables, as a
  substitute for its own exemption analysis or counsel's approval.
- SHOULD keep the classification attestation (`rwa.classification.v1`)
  distinct from any eligibility, identity, or accreditation attestation; the
  former describes the asset, the latter gate the holder.

These obligations run to the issuer. A conforming *consumer* incurs none of
them by reading, deriving, or displaying classification data — reading a
description of an instrument is not participation in its offering.

## 9. Governance

The author issues tokens in this category, which is a conflict worth stating
plainly: a classification standard authored solely by an issuer invites the
reading that it is a distribution land grab. Co-sponsorship is actively sought
from the Solana Foundation RWA group, Metaplex, and at least one competing
issuer, before this advances past draft.

Note on venue: sRFCs 00017 and 00020 predate the move to
[solana-foundation/SRFCs](https://github.com/solana-foundation/SRFCs) and are
cited from the retired forum, which cannot be replied into. Discussion of this
draft belongs in the GitHub thread.

Adoption bar before anyone should treat this as a standard:

1. Spec + reference implementation (reader, writer, CLI validator).
2. Registered public SAS schema.
3. **Two independent issuers** publishing conforming metadata.
4. **One wallet that is not the author's** rendering it.

Below that bar this is a blog post with a table in it.

## 10. Open questions

1. ~~SAS field encoding.~~ **Resolved** in §3.1 and verified on devnet (§3.6).
2. Should `rwa.claim` be multi-valued for hybrid instruments (converts,
   participating preferred)? Current view: no, use the senior characteristic and
   let discovery carry the detail. Multi-valued enums push complexity onto every
   reader.
3. Who maintains the `rwa.subclass` and `property_commit` namespace registries
   long-term? A flat file in a neutral repository is the proposal; it does not
   scale to contested namespaces.
4. ~~Legacy SPL Token mints and indexer-free discovery.~~ **Resolved** in §3.3:
   fixing the attestation PDA nonce to the subject mint makes the address
   derivable for any mint, so no pointer and no indexer are needed.
5. Is `rwa.jurisdiction` a single value in practice? Cross-border SPV structures
   may need a list.

## 11. Prior art

- **sRFC 00020** — permissioning and compliance mechanics; complementary.
- **ERC-3643 (T-REX) / ONCHAINID** — the closest analogue. Its signed claim
  topics from trusted issuers are the model for Layer 2; SAS supplies the same
  shape natively on Solana.
- **ERC-1400 / CMTAT** — security-token interfaces, again compliance-focused
  rather than classificatory.
- **ISO 10962 (CFI)** — instrument classification. Well-established prior art for
  the `rwa.claim` axis and worth aligning with in a later revision.
- **ISO 17442 (LEI) / GLEIF** — entity identity, verifiable against a free public
  API. The reason `issuer_lei` is preferred over a free-text issuer name.
- **Metaplex Token Metadata `uri`** — an off-chain pointer that already exists.
  This proposal's Layer 3 is that pattern plus the two things it lacks: payload
  signing and hash pinning.

## 12. Reference implementation

[`src/rwa-classification.ts`](https://github.com/pzupan/rwa-classification/blob/main/src/rwa-classification.ts) — a dependency-free parser,
validator, and trust resolver. Pure functions over already-fetched RPC data; no
crypto or RPC client is bundled, and signature verification is an injected seam
so the module runs unchanged on native, web, and MV3.

Decoding a SAS account is deliberately *not* its job; that belongs to the SDK.
The seam between them — decoded payload plus the account's native fields, in,
`AttestationView` out — is exercised in [`src/rwa-schema.test.ts`](https://github.com/pzupan/rwa-classification/blob/main/src/rwa-schema.test.ts).

| What | Where |
|---|---|
| Reader, validator, trust resolver | [`src/rwa-classification.ts`](https://github.com/pzupan/rwa-classification/blob/main/src/rwa-classification.ts) |
| Trust resolution tests | [`src/rwa-classification.test.ts`](https://github.com/pzupan/rwa-classification/blob/main/src/rwa-classification.test.ts) |
| §3.1 layout round-trip, against the real SDK | [`src/rwa-schema.test.ts`](https://github.com/pzupan/rwa-classification/blob/main/src/rwa-schema.test.ts) |
| Live devnet round-trip (§3.6) | [`scripts/sas-devnet.mjs`](https://github.com/pzupan/rwa-classification/blob/main/scripts/sas-devnet.mjs) |

`npm test` runs the offline suites on `node:test` with native TypeScript
stripping — no test runner dependency, so the module's dependency-free claim
survives contact with its own test suite. A CLI validator (adoption bar item 1,
§9) does not exist yet.

The resolver covers `rwa.classification.v1` and the §4 discovery document. It
does not yet resolve issuer standing (§3.8) or LEI bindings (§3.9): a consumer
using it today trusts classification credentials directly. Both schemas are
implemented on the writing side by ioniqx's platform, which is how their
layouts were exercised, but there is no independent reader for them yet.
