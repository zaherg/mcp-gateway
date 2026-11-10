/** A 64-character hex key from 32 browser crypto bytes, for a bearer setting. */
export const generateToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
