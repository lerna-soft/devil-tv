#!/usr/bin/env node
/**
 * Read XOR+base64 encrypted vault files used by this repository.
 * Usage:
 *   node tools/read-encrypted-vault.mjs [encrypted-file]
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const LEGACY_VAULT_SEED = 'mep_vault_seed_v1';
const DEFAULT_VAULT_FILE = path.join(PROJECT_ROOT, 'assets', 'secure', 'DAEdNhg-Fh4ROxYLEQ0-GkIyExEqGhU.vault');
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

function decryptLegacy(cipherText, seed) {
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

function decryptEpe(cipherText, filePath) {
  const value = String(cipherText || '').trim();
  if (!value.startsWith(EPE_PREFIX)) return null;
  const payload = value.slice(EPE_PREFIX.length);
  if (!payload) return '';
  const key = deriveEpeKeyFromFilename(filePath);
  if (!key.length) throw new Error('EPE key derivation failed: missing filename');
  const bytes = Buffer.from(payload, 'base64');
  const plain = xorWithKey(bytes, key);
  return plain.toString('utf8');
}

async function main() {
  const target = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : DEFAULT_VAULT_FILE;
  const raw = await fs.readFile(target, 'utf8');
  const plain = decryptEpe(raw, target) ?? decryptLegacy(raw, LEGACY_VAULT_SEED);
  process.stdout.write(plain.endsWith('\n') ? plain : `${plain}\n`);
}

await main();
