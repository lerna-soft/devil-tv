#!/usr/bin/env node
/**
 * Read EPE2 encrypted vault files used by this repository.
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

const DEFAULT_VAULT_FILE = path.join(PROJECT_ROOT, 'assets', 'secure', 'DAEdNhg-Fh4ROxYLEQ0-GkIyExEqGhU.vault');
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

function constantTimeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function decryptEpe(cipherText, filePath) {
  const value = String(cipherText || '').trim();
  if (!value.startsWith(EPE2_PREFIX)) {
    throw new Error('Unsupported vault format. Expected EPE2.');
  }
  const payload = value.slice(EPE2_PREFIX.length);
  if (!payload) return '';
  const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  const nonce = String(parsed?.n || '');
  const cipher = String(parsed?.p || '');
  const tag = String(parsed?.t || '');
  const key = deriveEpeKeyFromFilename(filePath);
  const macKey = deriveMacKey(filePath);
  if (!key.length || !macKey.length) throw new Error('EPE key derivation failed: missing filename');
  const expectedTag = crypto.createHmac('sha256', macKey).update(`${nonce}:${cipher}`).digest('hex');
  if (!constantTimeEqualHex(expectedTag, tag)) throw new Error('EPE integrity check failed');
  const plain = xorWithKey(Buffer.from(cipher, 'base64'), key).toString('utf8');
  return plain;
}

async function main() {
  const target = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : DEFAULT_VAULT_FILE;
  const raw = await fs.readFile(target, 'utf8');
  const plain = decryptEpe(raw, target);
  process.stdout.write(plain.endsWith('\n') ? plain : `${plain}\n`);
}

await main();
