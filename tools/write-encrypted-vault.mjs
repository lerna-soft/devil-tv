#!/usr/bin/env node
/**
 * Encrypt text to XOR+base64 vault format.
 * Usage:
 *   node tools/write-encrypted-vault.mjs <input-file> <output-file>
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const EPE2_PREFIX = 'EPE2:';

function xorWithKey(inputBytes, keyBytes) {
  const out = Buffer.alloc(inputBytes.length);
  for (let i = 0; i < inputBytes.length; i += 1) {
    out[i] = inputBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return out;
}

function deriveEpeKeyFromFilename(filePath) {
  const base = path.basename(String(filePath || '').trim());
  if (!base) return Buffer.alloc(0);
  return crypto.createHash('sha256').update(base, 'utf8').digest();
}

function deriveMacKey(filePath) {
  const base = path.basename(String(filePath || '').trim());
  if (!base) return Buffer.alloc(0);
  return crypto.createHash('sha256').update(`mac:${base}`, 'utf8').digest();
}

function encryptEpeV2(plainText, outputFile) {
  const text = String(plainText || '');
  const key = deriveEpeKeyFromFilename(outputFile);
  const macKey = deriveMacKey(outputFile);
  if (!key.length || !macKey.length) throw new Error('EPE key derivation failed: missing output filename');
  const nonce = crypto.randomBytes(12).toString('hex');
  const cipher = xorWithKey(Buffer.from(text, 'utf8'), key).toString('base64');
  const tag = crypto.createHmac('sha256', macKey).update(`${nonce}:${cipher}`).digest('hex');
  const payload = Buffer.from(JSON.stringify({ v: 2, n: nonce, p: cipher, t: tag }), 'utf8').toString('base64');
  return `${EPE2_PREFIX}${payload}`;
}

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];
  if (!inputFile || !outputFile) {
    throw new Error('Usage: node tools/write-encrypted-vault.mjs <input-file> <output-file>');
  }
  const plain = await fs.readFile(path.resolve(process.cwd(), inputFile), 'utf8');
  const resolvedOutput = path.resolve(process.cwd(), outputFile);
  const cipher = encryptEpeV2(plain, resolvedOutput);
  await fs.writeFile(resolvedOutput, `${cipher}\n`, 'utf8');
}

await main();
