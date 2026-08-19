/**
 * Creates the `rwa.classification.v1` SAS schema on devnet and round-trips one
 * attestation through it — the live counterpart to `src/lib/rwa-schema.test.ts`
 * and the source of the addresses quoted in spec §3.6.
 *
 * Idempotent: existing credential/schema/attestation accounts are reused, so
 * re-running verifies rather than duplicates.
 *
 *   SAS_KEYPAIR=/path/to/devnet-keypair.json npm run sas:devnet
 *
 * The keypair is a devnet fee payer and nothing else. It signs as both payer
 * and credential authority. Do not point this at a mainnet key.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  deserializeAttestationData,
  fetchMaybeAttestation,
  fetchMaybeCredential,
  fetchMaybeSchema,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  serializeAttestationData,
} from 'sas-lib';

/**
 * @solana/kit is resolved through sas-lib rather than imported directly.
 *
 * Two reasons. It is not a root dependency — kit 5's optional TypeScript peer
 * caps at ^5 and this project is on 6, so npm nests it under sas-lib and a
 * bare specifier does not resolve. And kit's Address/signer types are branded,
 * so two copies in one process would fail structural checks at the boundary;
 * borrowing sas-lib's copy guarantees exactly one.
 */
const {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} = createRequire(import.meta.resolve('sas-lib'))('@solana/kit');

const RPC_URL = process.env.SAS_RPC ?? 'https://api.devnet.solana.com';
const CREDENTIAL_NAME = 'ioniqx-rwa-draft';
const SCHEMA_NAME = 'rwa.classification.v1';
const VALIDITY_DAYS = 90;

/** Spec §3.1. Order is normative; Borsh is positional. */
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
];

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(value) {
  let n = 0n;
  for (const char of value) {
    const index = BASE58.indexOf(char);
    if (index < 0) throw new Error(`not base58: ${value}`);
    n = n * 58n + BigInt(index);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let leading = 0;
  for (const char of value) {
    if (char !== '1') break;
    leading++;
  }
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')]);
}

function base58Encode(bytes) {
  const buf = Buffer.from(bytes);
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

const keypairPath = process.env.SAS_KEYPAIR;
if (!keypairPath) {
  console.error('SAS_KEYPAIR must point at a devnet keypair JSON file.');
  process.exit(1);
}

const rpc = createSolanaRpc(RPC_URL);
const signer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8')))
);

const { value: balance } = await rpc.getBalance(signer.address).send();
console.log(`rpc       ${RPC_URL}`);
console.log(`authority ${signer.address} (${Number(balance) / 1e9} SOL)`);
if (balance === 0n) {
  console.error('authority has no SOL; fund it before running.');
  process.exit(1);
}

async function send(instructions, label) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send();

  for (let attempt = 0; attempt < 45; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`${label}: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      console.log(`  ${label} ${signature}`);
      return;
    }
  }
  throw new Error(`${label}: not confirmed in time`);
}

/* 1. Credential — the attesting organisation's stable identity (§3.5). */
const [credential] = await deriveCredentialPda({
  authority: signer.address,
  name: CREDENTIAL_NAME,
});
console.log(`\ncredential ${credential}`);
if ((await fetchMaybeCredential(rpc, credential)).exists) {
  console.log('  exists');
} else {
  await send(
    [
      getCreateCredentialInstruction({
        payer: signer,
        credential,
        authority: signer,
        name: CREDENTIAL_NAME,
        signers: [signer.address],
      }),
    ],
    'created'
  );
}

/* 2. Schema — the layout spec §3.1 pins. */
const [schema] = await deriveSchemaPda({ credential, name: SCHEMA_NAME, version: 1 });
console.log(`schema     ${schema}`);
if ((await fetchMaybeSchema(rpc, schema)).exists) {
  console.log('  exists');
} else {
  await send(
    [
      getCreateSchemaInstruction({
        payer: signer,
        authority: signer,
        credential,
        schema,
        name: SCHEMA_NAME,
        description: 'RWA asset classification (sRFC draft)',
        layout: Uint8Array.from(SCHEMA_FIELDS.map(([, code]) => code)),
        fieldNames: SCHEMA_FIELDS.map(([name]) => name),
      }),
    ],
    'created'
  );
}

const onchainSchema = await fetchMaybeSchema(rpc, schema);

/* 3. Attestation — nonce is the subject mint, so the address derives (§3.3). */
const subjectMint = address(
  process.env.SAS_MINT ?? 'So11111111111111111111111111111111111111112'
);
const [attestation] = await deriveAttestationPda({ credential, schema, nonce: subjectMint });
console.log(`attestation ${attestation}`);
console.log(`  derived from (credential, schema, mint=${subjectMint})`);

const data = {
  mint: base58Decode(subjectMint),
  class: 'real-estate',
  claim: 'equity',
  subclass: 'multifamily',
  jurisdiction: 'US-TX',
  issuer_lei: '5493001KJTIIGC8Y1R12',
  property_commit: Buffer.alloc(32, 9),
  discovery_url: 'https://issuer.example/.well-known/rwa.json',
  discovery_signer: base58Decode(signer.address),
};

if ((await fetchMaybeAttestation(rpc, attestation)).exists) {
  console.log('  exists');
} else {
  await send(
    [
      getCreateAttestationInstruction({
        payer: signer,
        authority: signer,
        credential,
        schema,
        attestation,
        nonce: subjectMint,
        data: serializeAttestationData(onchainSchema.data, data),
        expiry: BigInt(Math.floor(Date.now() / 1000) + VALIDITY_DAYS * 86_400),
      }),
    ],
    'created'
  );
}

/* 4. Read back from chain and check the round-trip. */
const fetched = await fetchMaybeAttestation(rpc, attestation);
if (!fetched.exists) throw new Error('attestation missing after create');

const decoded = deserializeAttestationData(
  onchainSchema.data,
  Uint8Array.from(fetched.data.data)
);

console.log('\nread back from chain');
console.log(`  credential (native)  ${fetched.data.credential}`);
console.log(`  signer (native)      ${fetched.data.signer}`);
console.log(`  expiry (native)      ${fetched.data.expiry}`);
console.log(`  class / claim        ${decoded.class} / ${decoded.claim}`);
console.log(`  subclass             ${decoded.subclass}`);
console.log(`  jurisdiction / lei   ${decoded.jurisdiction} / ${decoded.issuer_lei}`);
console.log(`  discovery_url        ${decoded.discovery_url}`);
console.log(`  discovery_signer     ${base58Encode(decoded.discovery_signer)}`);

const checks = [
  ['payload mint matches the PDA nonce', base58Encode(decoded.mint) === subjectMint],
  ['class survived', decoded.class === data.class],
  ['claim survived', decoded.claim === data.claim],
  ['jurisdiction survived', decoded.jurisdiction === data.jurisdiction],
  ['issuer_lei survived', decoded.issuer_lei === data.issuer_lei],
  ['discovery_url survived', decoded.discovery_url === data.discovery_url],
  ['property_commit is 32 bytes', decoded.property_commit.length === 32],
  ['discovery_signer is 32 bytes', decoded.discovery_signer.length === 32],
  ['expiry is set on the account', fetched.data.expiry > 0n],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
