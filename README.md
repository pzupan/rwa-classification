# RWA Asset Classification and Data Discovery

A draft Solana application standard for declaring **what real-world asset a token
represents**, **what claim the holder has on it**, and **where to find the
extended data** — bound to an expiring on-chain attestation so the declaration is
verifiable rather than merely asserted.

**[Read the specification →](SPEC.md)**

Status: **draft, unnumbered, seeking comment and co-sponsors.**
Discussion belongs in [solana-foundation/SRFCs](https://github.com/solana-foundation/SRFCs/discussions).

## Why

Nothing today lets a wallet, indexer, or aggregator determine that a Solana mint
represents real estate — or any other asset class — without per-issuer bespoke
integration. Self-declared metadata does not solve it: minting a token named
`RVBND` with matching metadata costs a few cents, so a wallet that renders a
self-declared string as authoritative becomes a phishing surface.

This proposal is deliberately small. It adds a shared vocabulary and a binding
from that vocabulary to someone accountable. It does **not** specify transfer
compliance — that is [sRFC 00020](https://forum.solana.com/t/srfc-00020-rwa-security-token-standard/370)'s
subject, and scope creep is what stalled that thread.

## Three layers

| Layer | Location | Trust |
|---|---|---|
| Classification | Token-2022 `additionalMetadata` on the mint | Self-declared |
| Attestation | [Solana Attestation Service](https://attest.solana.com/) | Verified, expiring |
| Discovery | Off-chain, signed and hash-pinned | Mixed |

Layer 1 alone is a convenience and must never be presented as verified. Layer 2
works standalone, which is how legacy SPL Token mints participate at all.

## What is verifiable today

The schema encoding in §3.1 is pinned against `sas-lib@1.0.10` and was created
and round-tripped on devnet. These accounts are live:

| Account | Address |
|---|---|
| Credential | `5Es4gSTWYemJxPMkWGYAi56Xzf2cSosJBRMaQaVVuxZq` |
| Schema | `ASE1gwae1gBPZctkdNXdyGJcmqwPMVW9iMHqs22bJa9p` |
| Example attestation | `G6qArVxuNwL9aC3EpTY443TfVTfyFmKwQhgmnd6rht9b` |

They are a draft artifact to read against — not a trust root, and not a mainnet
registration.

## Reference implementation

`src/rwa-classification.ts` is a dependency-free parser, validator, and trust
resolver: pure functions over already-fetched RPC data, with no crypto client,
no RPC client, and signature verification as an injected seam, so it runs
unchanged on native, web, and inside an MV3 browser extension.

Decoding a SAS account is deliberately not its job — that belongs to the SDK.

```bash
npm install
npm test        # offline suites, no network
npm run typecheck
```

Tests run on `node:test` with Node's native TypeScript stripping, so a
dependency-free module stays dependency-free even under test. `sas-lib` is a
dev dependency only: the schema tests go through the real serializer rather than
a local reimplementation, so they fail when the SDK drifts away from what the
document claims. Requires Node 24+.

To repeat the on-chain round-trip yourself:

```bash
SAS_KEYPAIR=/path/to/devnet-keypair.json npm run sas:devnet
```

Idempotent — it reuses existing accounts, so re-running verifies rather than
duplicates. Devnet only; do not point it at a mainnet key.

## Before this is a standard

From §8 of the spec, none of which is met yet:

1. Spec and reference implementation (reader, writer, CLI validator) — *reader done, no writer or validator*
2. A registered public SAS schema on mainnet — *devnet only*
3. **Two independent issuers** publishing conforming metadata
4. **One wallet that is not the author's** rendering it

Below that bar this is a blog post with a table in it.

## Conflict of interest

The author issues tokens in this category. A classification standard authored
solely by an issuer invites the reading that it is a distribution land grab,
which is why §3.7 refuses to name trusted attesters, §8 sets the adoption bar
above, and co-sponsorship is sought before this advances past draft.

## License

Apache-2.0.
