const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_THEME, mergeTheme, validateTheme } = require("../src/theme");

test("merges valid persisted values with theme defaults", () => {
  assert.deepEqual(
    mergeTheme({ accent: "#FF00AA" }),
    { ...DEFAULT_THEME, accent: "#ff00aa" }
  );
});

test("rejects unsafe colors and invalid interface settings", () => {
  assert.throws(
    () => validateTheme({ ...DEFAULT_THEME, background: "red; color: blue" }),
    /six-digit hex/
  );
  assert.throws(
    () => validateTheme({ ...DEFAULT_THEME, fontFamily: "url(https://evil.test)" }),
    /font family/
  );
  assert.throws(
    () => validateTheme({ ...DEFAULT_THEME, fontSize: 99 }),
    /font size/
  );
});
