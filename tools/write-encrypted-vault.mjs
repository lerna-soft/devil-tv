#!/usr/bin/env node
/**
 * Encrypt text to XOR+base64 vault format.
 * Usage:
 *   node tools/write-encrypted-vault.mjs <input-file> <output-file>
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const VAULT_SEED = 'mep_vault_seed_v1';

function encrypt(plainText, seed) {
  const text = String(plainText || '');
  const key = String(seed || '').trim();
  if (!key) return '';
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(out, 'binary').toString('base64');
}

async function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];
  if (!inputFile || !outputFile) {
    throw new Error('Usage: node tools/write-encrypted-vault.mjs <input-file> <output-file>');
  }
  const plain = await fs.readFile(path.resolve(process.cwd(), inputFile), 'utf8');
  const cipher = encrypt(plain, VAULT_SEED);
  await fs.writeFile(path.resolve(process.cwd(), outputFile), `${cipher}\n`, 'utf8');
}

await main();
