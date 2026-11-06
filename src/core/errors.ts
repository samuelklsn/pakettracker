/** Typed error hierarchy so the UI can render precise, user-friendly messages. */

export class AppError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** AES-GCM authentication failed → wrong password OR tampered ciphertext. */
export class DecryptionError extends AppError {}

/** Stored/imported data does not match the expected envelope schema. */
export class InvalidVaultFormatError extends AppError {}

/** localStorage is full or unavailable. */
export class StorageUnavailableError extends AppError {}

/** Web Crypto API missing (e.g. insecure context over plain http). */
export class CryptoUnavailableError extends AppError {}

export class TrackingProviderError extends AppError {}

export function errorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unbekannter Fehler';
}
