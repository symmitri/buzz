// Symmitri modification: presentation only; persisted IDs and protocols stay unchanged.
export const IS_SPACES_ALPHA = import.meta.env?.VITE_SPACES_ALPHA === "1";
export const PRODUCT_NAME = IS_SPACES_ALPHA ? "Spaces" : "Buzz";
export const TERMINAL_NAME = IS_SPACES_ALPHA ? "Terminal" : "Buzz Term";
