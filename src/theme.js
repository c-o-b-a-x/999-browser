const DEFAULT_THEME = Object.freeze({
  background: "#101418",
  surface: "#191f24",
  accent: "#83dbc2",
  text: "#e8edf0",
  muted: "#91a0a9",
  fontFamily: "Segoe UI",
  colorScheme: "dark",
  fontSize: 14,
  cornerRadius: 9
});

const FONT_FAMILIES = new Set(["Segoe UI", "Arial", "Georgia", "Consolas", "Tahoma"]);

function validateTheme(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Theme settings must be an object.");
  }
  const result = {};
  for (const key of ["background", "surface", "accent", "text", "muted"]) {
    if (typeof value[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(value[key])) {
      throw new TypeError(`Theme color "${key}" must be a six-digit hex color.`);
    }
    result[key] = value[key].toLowerCase();
  }
  if (!FONT_FAMILIES.has(value.fontFamily)) {
    throw new TypeError("Theme font family is not supported.");
  }
  if (!["dark", "light"].includes(value.colorScheme)) {
    throw new TypeError("Theme color scheme must be light or dark.");
  }
  if (!Number.isInteger(value.fontSize) || value.fontSize < 12 || value.fontSize > 20) {
    throw new TypeError("Theme font size must be between 12 and 20.");
  }
  if (
    !Number.isInteger(value.cornerRadius) ||
    value.cornerRadius < 0 ||
    value.cornerRadius > 24
  ) {
    throw new TypeError("Theme corner radius must be between 0 and 24.");
  }
  return {
    ...result,
    fontFamily: value.fontFamily,
    colorScheme: value.colorScheme,
    fontSize: value.fontSize,
    cornerRadius: value.cornerRadius
  };
}

function mergeTheme(value) {
  return validateTheme({ ...DEFAULT_THEME, ...value });
}

const themeApi = { DEFAULT_THEME, mergeTheme, validateTheme };
if (typeof module !== "undefined" && module.exports) {
  module.exports = themeApi;
} else {
  globalThis.QuietTheme = themeApi;
}
