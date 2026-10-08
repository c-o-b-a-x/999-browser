(function initializeQolSettings() {
const DEFAULT_QOL_SETTINGS = Object.freeze({
  forceDarkMode: false,
  cursorAsset: null,
  wallpaperAsset: null,
  typingSounds: true,
  clickSounds: true,
  showBranding: true,
  showHeadline: true,
  showIntro: true,
  showSearchBar: true,
  showPrivacyNote: true
});

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ASSET_ID_PATTERN = new RegExp(
  `^(?:cursor-${UUID_PATTERN}\\.png|wallpaper-${UUID_PATTERN}\\.(?:png|jpe?g))$`,
  "i"
);

function validateQolSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Browser preferences must be an object.");
  }
  const settings = { ...DEFAULT_QOL_SETTINGS, ...value };
  for (const key of [
    "forceDarkMode",
    "typingSounds",
    "clickSounds",
    "showBranding",
    "showHeadline",
    "showIntro",
    "showSearchBar",
    "showPrivacyNote"
  ]) {
    if (typeof settings[key] !== "boolean") {
      throw new TypeError(`Preference "${key}" must be boolean.`);
    }
  }
  for (const key of ["cursorAsset", "wallpaperAsset"]) {
    if (settings[key] !== null && (
      typeof settings[key] !== "string" ||
      !ASSET_ID_PATTERN.test(settings[key]) ||
      !settings[key].toLowerCase().startsWith(
        key === "cursorAsset" ? "cursor-" : "wallpaper-"
      )
    )) {
      throw new TypeError(`Preference "${key}" must be a supported local image identifier.`);
    }
  }
  return {
    forceDarkMode: settings.forceDarkMode,
    cursorAsset: settings.cursorAsset,
    wallpaperAsset: settings.wallpaperAsset,
    typingSounds: settings.typingSounds,
    clickSounds: settings.clickSounds,
    showBranding: settings.showBranding,
    showHeadline: settings.showHeadline,
    showIntro: settings.showIntro,
    showSearchBar: settings.showSearchBar,
    showPrivacyNote: settings.showPrivacyNote
  };
}

function getAssetFileName(value, kind) {
  if (
    typeof value !== "string" ||
    !ASSET_ID_PATTERN.test(value) ||
    !value.startsWith(`${kind}-`) ||
    (kind === "cursor" && !value.toLowerCase().endsWith(".png"))
  ) {
    throw new Error(`Invalid ${kind} image identifier.`);
  }
  return value;
}

function inspectPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let dimensions = null;
  let hasImageData = false;
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkEnd > buffer.length) return null;
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    if (!dimensions) {
      if (chunkType !== "IHDR" || chunkLength !== 13) return null;
      dimensions = {
        type: "image/png",
        width: buffer.readUInt32BE(offset + 8),
        height: buffer.readUInt32BE(offset + 12)
      };
    }
    if (chunkType === "IDAT") hasImageData = true;
    if (chunkType === "IEND") {
      return chunkLength === 0 && hasImageData ? dimensions : null;
    }
    offset = chunkEnd;
  }
  return null;
}

function inspectJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);
  let dimensions = null;
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xda) {
      if (offset + 2 > buffer.length) return null;
      const scanLength = buffer.readUInt16BE(offset);
      if (
        !dimensions ||
        scanLength < 2 ||
        offset + scanLength > buffer.length ||
        buffer[buffer.length - 2] !== 0xff ||
        buffer[buffer.length - 1] !== 0xd9
      ) return null;
      return dimensions;
    }
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      dimensions = {
        type: "image/jpeg",
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += segmentLength;
  }
  return null;
}

function inspectImage(buffer, extension) {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === ".png") return inspectPng(buffer);
  if (normalizedExtension === ".jpg" || normalizedExtension === ".jpeg") {
    return inspectJpeg(buffer);
  }
  return null;
}

function validateImage(buffer, extension, kind) {
  const image = inspectImage(buffer, extension);
  if (!image || !image.width || !image.height) {
    throw new Error("The selected file is not a supported PNG or JPEG image.");
  }
  if (buffer.length > 20 * 1024 * 1024) {
    throw new Error("Images must be 20 MB or smaller.");
  }
  if (kind === "cursor" && (
    image.type !== "image/png" ||
    buffer.length > 1024 * 1024 ||
    image.width > 128 ||
    image.height > 128
  )) {
    throw new Error("Cursor images must be PNG files no larger than 128 by 128 pixels.");
  }
  if (kind === "wallpaper" && (
    image.width > 8192 ||
    image.height > 8192 ||
    image.width * image.height > 40_000_000
  )) {
    throw new Error("Wallpaper images may not exceed 8192 by 8192 pixels.");
  }
  return image;
}

function isTypingSoundTarget({ trusted, tagName, type, insideBrowserForm }) {
  if (
    !trusted ||
    !insideBrowserForm ||
    !["INPUT", "TEXTAREA"].includes(tagName) ||
    type === "password"
  ) return false;
  return tagName === "TEXTAREA" ||
    ["text", "search", "email", "url", "number"].includes(type);
}

const qolSettingsApi = {
  DEFAULT_QOL_SETTINGS,
  getAssetFileName,
  inspectImage,
  isTypingSoundTarget,
  validateImage,
  validateQolSettings
};
if (typeof module !== "undefined" && module.exports) {
  module.exports = qolSettingsApi;
} else {
  globalThis.QuietQolSettings = qolSettingsApi;
}
})();
