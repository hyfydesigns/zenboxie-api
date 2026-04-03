/**
 * EncryptionService — AES-256-GCM symmetric encryption for stored credentials.
 *
 * Format stored: base64(iv[12] + authTag[16] + ciphertext)
 *
 * Set ENCRYPTION_KEY in .env:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;   // 96-bit IV — recommended for GCM
const TAG_BYTES = 16;  // 128-bit auth tag

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  }
  return Buffer.from(hex, "hex");
}

module.exports = {
  encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64");
  },

  decrypt(encoded) {
    const buf = Buffer.from(encoded, "base64");
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
  },
};
