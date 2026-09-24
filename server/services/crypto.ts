import crypto from "crypto";

function key(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (secret.length < 16) throw new Error("TOKEN_ENCRYPTION_KEY must be set (16+ characters)");
  return crypto.createHash("sha256").update(secret).digest();
}

/** AES-256-GCM. Output format: base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(payload: string): string {
  if (!payload) return "";
  const buf = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}
