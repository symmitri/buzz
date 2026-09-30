import { IS_SPACES_ALPHA } from "./product-brand";

/** Device date context only; never identity or access authority. */
export function spacesTimeZone(): string | undefined {
  if (!IS_SPACES_ALPHA) return undefined;
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return value && value.length <= 128 && /^[A-Za-z0-9_+\-/]+$/.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
