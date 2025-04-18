/**
 * Sanitizes a string to be used as a filename.
 * - Removes http(s)://(www.) prefix.
 * - Replaces non-alphanumeric characters (except _, ., -) with underscores.
 * - Truncates to a maximum length.
 * @param name The original string (URL or topic).
 * @param maxLength The maximum allowed filename length.
 * @returns A sanitized string suitable for use as a filename.
 */
export function sanitizeFilename(name: string, maxLength: number = 100): string {
  return name
    .replace(/^(?:https?:\/\/)?(?:www\.)?/i, '') // Remove protocol and www.
    .replace(/[^a-z0-9_.-]/gi, '_') // Replace invalid chars with _
    .substring(0, maxLength); // Truncate
}