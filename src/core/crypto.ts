import crypto from 'node:crypto';
import { ComciParseError } from './errors.js';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/i;
const eucKrDecoder = new TextDecoder('euc-kr', { fatal: true });

/**
 * Decrypts Comcigan encrypted response payload (`<digits>:` base64 or `enc1:` hex).
 * Verifies HMAC-SHA256 tag against SHA256(key) before AES-CBC decryption.
 */
export function decryptComciPayload(
  rawData: string,
  aesKeyHex: string,
  base64Prefix?: string
): string {
  const data = rawData.replace(/\0+$/, '');
  const prefixMatch = data.match(/^([A-Za-z0-9]+):/);
  if (!prefixMatch) {
    return data;
  }

  const detectedPrefix = prefixMatch[1];
  const isHexEnc = detectedPrefix === 'enc1';
  const isBase64Enc = base64Prefix
    ? detectedPrefix === base64Prefix
    : /^\d+$/.test(detectedPrefix);

  if (!isHexEnc && !isBase64Enc) {
    return data;
  }

  const parts = data.split(':');
  if (parts.length !== 4) {
    throw new ComciParseError('Invalid encrypted timetable payload format.');
  }

  const useBase64 = isBase64Enc;
  const encoding: BufferEncoding = useBase64 ? 'base64' : 'hex';
  const validator = useBase64 ? BASE64_PATTERN : HEX_PATTERN;

  const [prefix, ivStr, ctStr, tagStr] = parts;
  if (!validator.test(ivStr) || !validator.test(ctStr) || !validator.test(tagStr)) {
    throw new ComciParseError('Invalid encrypted timetable encoding.');
  }

  const iv = Buffer.from(ivStr, encoding);
  const ciphertext = Buffer.from(ctStr, encoding);
  const tag = Buffer.from(tagStr, encoding);

  if (iv.length !== 16 || tag.length !== 32 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new ComciParseError('Invalid encrypted timetable block sizes.');
  }

  const key = Buffer.from(aesKeyHex, 'hex');
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new ComciParseError(`Invalid AES key length: ${key.length} bytes.`);
  }

  const hmacKey = crypto.createHash('sha256').update(key).digest();
  const expectedTag = crypto
    .createHmac('sha256', hmacKey)
    .update(`${prefix}:${ivStr}:${ctStr}`)
    .digest();

  if (tag.length !== expectedTag.length || !crypto.timingSafeEqual(tag, expectedTag)) {
    throw new ComciParseError('Timetable HMAC authentication failed.');
  }

  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8').replace(/\0+$/, '');
}

/**
 * Decodes a base64 + XOR + EUC-KR encoded field string (mirrors `K0eiLN`).
 */
export function decodeXorEucKr(encoded: string | undefined | null, xorKey: string): string {
  if (encoded === undefined || encoded === null || encoded === '') {
    return '';
  }

  const bytes = Buffer.from(encoded, 'base64');
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ xorKey.charCodeAt(i % xorKey.length);
  }
  return eucKrDecoder.decode(out);
}

/**
 * Formats teacher name according to Comcigan's `Hg6GVP` rule.
 */
export function formatTeacherName(raw: string | undefined | null, xorKey: string): string {
  if (raw === undefined || raw === null || raw === '') {
    return '';
  }
  const decoded = decodeXorEucKr(raw, xorKey);
  if (
    (decoded.includes('*') && !decoded.startsWith('*') && !decoded.endsWith('*')) ||
    (decoded.length === 2 && decoded[1] === '*')
  ) {
    return decoded;
  }
  return decoded.replace('*', '');
}
