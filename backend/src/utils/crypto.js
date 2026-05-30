'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env variable is required');
  // Derive a 32-byte key from whatever the user provides
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypts a plain-text string.
 * Returns "iv_hex:encrypted_hex" so the IV travels with the ciphertext.
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a value produced by encrypt().
 */
function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  const [ivHex, encHex] = ciphertext.split(':');
  if (!ivHex || !encHex) throw new Error('Invalid ciphertext format');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Returns a safe display version of a connection config (no passwords).
 */
function maskConnectionConfig(config) {
  if (!config) return config;
  const masked = { ...config };
  if (masked.password) masked.password = '***';
  if (masked.connectionString) masked.connectionString = masked.connectionString.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  return masked;
}

module.exports = { encrypt, decrypt, maskConnectionConfig };
