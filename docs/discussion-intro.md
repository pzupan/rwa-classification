<!--
Lead paragraphs for the GitHub Discussion post.

The full post body is this file (minus this comment) followed by SPEC.md with
its H1 removed, since the Discussion title already carries it. Build it with:

    npm run post

Kept separate so the spec text is never duplicated in this repository.
-->

Posting this as a draft for comment. It is deliberately narrow, and it is meant
to sit **alongside** [sRFC 00020](https://forum.solana.com/t/srfc-00020-rwa-security-token-standard/370),
not compete with it — 00020 owns permissioning, clawback, halts, and
distributions, and none of that is in scope here.

**What this adds.** When classification came up in the 00020 thread, the
resolution was that issuers should self-declare their asset type and implement
matching logic. That works for an issuer's own product surface and breaks down
for anyone consuming tokens they did not issue: a self-declared string with no
attestation is trivially spoofed, and minting a lookalike with matching metadata
costs a few cents. This proposal adds a small shared vocabulary and a binding
from that vocabulary to someone accountable — nothing more.

**What is already verifiable**, because a spec with no implementation is a blog
post with a table in it:

- The §3.1 schema encoding is pinned against `sas-lib@1.0.10` and round-trips
  on devnet. Credential `5Es4gSTWYemJxPMkWGYAi56Xzf2cSosJBRMaQaVVuxZq`, schema
  `ASE1gwae1gBPZctkdNXdyGJcmqwPMVW9iMHqs22bJa9p`, example attestation
  `G6qArVxuNwL9aC3EpTY443TfVTfyFmKwQhgmnd6rht9b`.
- A dependency-free reference reader with 60 tests, including a layout
  round-trip through the real SDK rather than a reimplementation:
  <https://github.com/pzupan/rwa-classification>
- No new program. This uses SAS as deployed.

**Three findings from building it** that may be useful regardless of what happens
to this proposal:

1. SAS has no pubkey type code and no fixed-size byte array, so any schema
   carrying keys or hashes has to choose `Vec<u8>` or `String` and say which.
2. Fixing the attestation PDA nonce to the subject mint makes attestations
   discoverable by derivation — no indexer, no pointer, and it works for legacy
   SPL mints that cannot carry metadata.
3. There is no revoke instruction. `closeAttestation` deletes the account, so to
   anyone reading accounts a revoked attestation is byte-identical to one that
   never existed. Short expiry, not revocation, has to be the real control.

**What I am asking for.** Co-sponsorship before this advances past draft —
specifically from the Foundation RWA group, Metaplex, and at least one competing
issuer. I issue tokens in this category, and a classification standard authored
solely by an issuer invites the reading that it is a distribution land grab. That
is also why §3.7 refuses to name trusted attesters and why the adoption bar in §8
is set where it is.

Open questions I would most like comment on: whether `rwa.claim` should be
multi-valued for hybrid instruments (§9.2), who maintains the subclass and
namespace registries long-term (§9.3), and whether `rwa.jurisdiction` needs to
be a list for cross-border SPV structures (§9.5).

---

