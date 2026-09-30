// Verify Tauri's Minisign artifact, then write its private Alpha feed metadata.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyArchive(bytes, encodedSignature, encodedKey) {
  const keyLines = Buffer.from(encodedKey.trim(), 'base64').toString('utf8').trim().split('\n');
  const lines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split('\n');
  assert.equal(keyLines.length, 2, 'Invalid public key');
  assert.equal(lines.length, 4, 'Invalid archive signature');
  const key = Buffer.from(keyLines[1], 'base64');
  const signature = Buffer.from(lines[1], 'base64');
  assert.equal(key.length, 42);
  assert.equal(signature.length, 74);
  assert.equal(key.subarray(0, 2).toString(), 'Ed');
  assert.equal(signature.subarray(0, 2).toString(), 'ED');
  assert(timingSafeEqual(key.subarray(2, 10), signature.subarray(2, 10)), 'Wrong Alpha signing key');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  assert(verify(null, createHash('blake2b512').update(bytes).digest(), publicKey, signature.subarray(10)), 'Invalid archive signature');
  assert(lines[2].startsWith('trusted comment: '), 'Missing signature metadata');
  assert(verify(null, Buffer.concat([signature.subarray(10), Buffer.from(lines[2].slice(17))]), publicKey, Buffer.from(lines[3], 'base64')), 'Invalid signature metadata');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, configFile] = process.argv.slice(2);
  assert(output && configFile && path.isAbsolute(output) && path.isAbsolute(configFile));
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(config.identifier, 'ai.symmitri.spaces.alpha');
  const endpoint = 'https://spaces-alpha-updates-334562777753.europe-west1.run.app/alpha.json';
  assert.deepEqual(config.plugins.updater.endpoints, [endpoint]);
  const archive = path.join(output, 'Spaces Alpha.app.tar.gz');
  const bytes = readFileSync(archive);
  const signature = readFileSync(`${archive}.sig`, 'utf8').trim();
  verifyArchive(bytes, signature, config.plugins.updater.pubkey);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const key = `payloads/${digest}.tar.gz`;
  mkdirSync(path.join(output, 'payloads'));
  copyFileSync(archive, path.join(output, key));
  const receipt = JSON.parse(readFileSync(path.join(output, 'source.json'), 'utf8'));
  writeFileSync(path.join(output, 'alpha.json'), JSON.stringify({
    version: config.version, notes: 'Spaces Alpha development update.', pub_date: new Date().toISOString(),
    platforms: { 'darwin-aarch64': { signature, url: new URL(key, endpoint).href } },
  }, null, 2) + '\n');
  writeFileSync(path.join(output, 'update-receipt.json'), JSON.stringify({
    identity: config.identifier, version: config.version, payload: key, sha256: digest, bytes: bytes.length,
    buzzCommit: receipt.commit, patchSha256: receipt.patchSha256, publicKey: config.plugins.updater.pubkey,
  }, null, 2) + '\n');
  unlinkSync(archive);
  unlinkSync(`${archive}.sig`);
  console.log(`ALPHA_UPDATE_VERIFIED ${config.version} ${digest}`);
}
