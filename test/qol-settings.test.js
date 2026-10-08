const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const {
  DEFAULT_QOL_SETTINGS,
  getAssetFileName,
  inspectImage,
  isTypingSoundTarget,
  validateImage,
  validateQolSettings
} = require("../src/qol-settings");

function makePng(width, height) {
  const buffer = Buffer.alloc(58);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  function writeChunk(offset, type, data) {
    buffer.writeUInt32BE(data.length, offset);
    buffer.write(type, offset + 4, "ascii");
    data.copy(buffer, offset + 8);
    return offset + 12 + data.length;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  let offset = writeChunk(8, "IHDR", header);
  offset = writeChunk(offset, "IDAT", Buffer.from([0]));
  writeChunk(offset, "IEND", Buffer.alloc(0));
  return buffer;
}

function makeJpeg(width, height) {
  const buffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9
  ]);
  return buffer;
}

test("provides the expected local QOL defaults and rejects invalid preferences", () => {
  assert.deepEqual(validateQolSettings(), DEFAULT_QOL_SETTINGS);
  for (const key of [
    "showBranding",
    "showHeadline",
    "showIntro",
    "showSearchBar",
    "showPrivacyNote"
  ]) {
    assert.equal(DEFAULT_QOL_SETTINGS[key], true);
  }
  assert.throws(
    () => validateQolSettings({ forceDarkMode: "yes" }),
    /must be boolean/
  );
  assert.throws(
    () => validateQolSettings({ showSearchBar: "on" }),
    /must be boolean/
  );
  assert.throws(
    () => validateQolSettings({ cursorAsset: "..\\outside.png" }),
    /supported local image identifier/
  );
  assert.throws(
    () => validateQolSettings({
      cursorAsset: "cursor-12345678-1234-1234-1234-123456789abc.jpg"
    }),
    /supported local image identifier/
  );
  assert.throws(
    () => validateQolSettings({
      wallpaperAsset: "cursor-12345678-1234-1234-1234-123456789abc.png"
    }),
    /supported local image identifier/
  );
});

test("accepts only safe image asset identifiers and bounded PNG cursor images", () => {
  const validId = "cursor-12345678-1234-1234-1234-123456789abc.png";
  assert.equal(getAssetFileName(validId, "cursor"), validId);
  assert.throws(() => getAssetFileName(validId, "wallpaper"), /Invalid wallpaper/);
  const image = makePng(64, 64);
  assert.deepEqual(inspectImage(image, ".png"), {
    type: "image/png",
    width: 64,
    height: 64
  });
  assert.equal(validateImage(image, ".png", "cursor").width, 64);
  assert.throws(
    () => validateImage(makePng(129, 64), ".png", "cursor"),
    /128 by 128/
  );
  assert.throws(
    () => validateImage(makePng(8193, 64), ".png", "wallpaper"),
    /8192 by 8192/
  );
  assert.throws(
    () => validateImage(Buffer.from("not an image"), ".png", "wallpaper"),
    /not a supported/
  );
});

test("inspects JPEG image dimensions for wallpaper validation", () => {
  const jpeg = makeJpeg(320, 200);
  assert.deepEqual(inspectImage(jpeg, ".jpg"), {
    type: "image/jpeg",
    width: 320,
    height: 200
  });
  assert.equal(validateImage(jpeg, ".jpeg", "wallpaper").height, 200);
  assert.equal(inspectImage(jpeg, ".png"), null);
});

test("types sounds only for trusted browser-interface text inputs, excluding passwords", () => {
  const allowed = {
    trusted: true,
    tagName: "INPUT",
    type: "text",
    insideBrowserForm: true
  };
  assert.equal(isTypingSoundTarget(allowed), true);
  assert.equal(isTypingSoundTarget({ ...allowed, type: "password" }), false);
  assert.equal(isTypingSoundTarget({ ...allowed, trusted: false }), false);
  assert.equal(isTypingSoundTarget({ ...allowed, insideBrowserForm: false }), false);
  assert.equal(isTypingSoundTarget({ ...allowed, tagName: "BUTTON" }), false);
  assert.equal(
    isTypingSoundTarget({
      trusted: true,
      tagName: "TEXTAREA",
      type: "textarea",
      insideBrowserForm: true
    }),
    true
  );
});

test("keeps browser helper declarations isolated from renderer top-level bindings", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "qol-settings.js"),
    "utf8"
  );
  const browserContext = vm.createContext({});
  browserContext.window = browserContext;
  vm.runInContext(source, browserContext);
  assert.doesNotThrow(() => vm.runInContext(
    "const { isTypingSoundTarget } = window.QuietQolSettings;",
    browserContext
  ));
});

test("keeps hidden start-page features hidden when component styles set display", () => {
  const stylesheet = fs.readFileSync(
    path.join(__dirname, "..", "src", "styles.css"),
    "utf8"
  );
  assert.match(stylesheet, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
