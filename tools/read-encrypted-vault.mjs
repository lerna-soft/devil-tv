#!/usr/bin/env node
/**
 * Read XOR+base64 encrypted vault files used by this repository.
 * Usage:
 *   node tools/read-encrypted-vault.mjs [encrypted-file]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const VAULT_SEED = 'mep_vault_seed_v1';
const DEFAULT_VAULT_FILE = path.join(PROJECT_ROOT, 'assets', 'secure', 'DAEdNhg-Fh4ROxYLEQ0-GkIyExEqGhU.vault');

function decrypt(cipherText, seed) {
  const encoded = String(cipherText || '').trim();
  const key = String(seed || '').trim();
  if (!encoded || !key) return '';
  const bytes = Buffer.from(encoded, 'base64').toString('binary');
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

async function main() {
  const target = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : DEFAULT_VAULT_FILE;
  const raw = await fs.readFile(target, 'utf8');
  const plain = decrypt(raw, VAULT_SEED);
  process.stdout.write(plain.endsWith('\n') ? plain : `${plain}\n`);
}

await main();
