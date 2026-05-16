#!/usr/bin/env node
/**
 * Encrypt text to XOR+base64 vault format.
 * Usage:
 *   node tools/write-encrypted-vault.mjs <input-file> <output-file>
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const EPE_PREFIX = 'EPE1:';

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

function encryptEpe(plainText, outputFile) {
  const text = String(plainText || '');
  const key = deriveEpeKeyFromFilename(outputFile);
  if (!key.length) throw new Error('EPE key derivation failed: missing output filename');
  const cipher = xorWithKey(Buffer.from(text, 'utf8'), key).toString('base64');
  return `${EPE_PREFIX}${cipher}`;
}

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];
  if (!inputFile || !outputFile) {
    throw new Error('Usage: node tools/write-encrypted-vault.mjs <input-file> <output-file>');
  }
  const plain = await fs.readFile(path.resolve(process.cwd(), inputFile), 'utf8');
  const resolvedOutput = path.resolve(process.cwd(), outputFile);
  const cipher = encryptEpe(plain, resolvedOutput);
  await fs.writeFile(resolvedOutput, `${cipher}\n`, 'utf8');
}

await main();
