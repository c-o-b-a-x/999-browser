const test = require("node:test");
const assert = require("node:assert/strict");
const { isCanceledNavigation } = require("../src/navigation-errors");

test("recognizes Electron canceled and superseded navigation failures", () => {
  assert.equal(isCanceledNavigation(-3, "ERR_ABORTED"), true);
  assert.equal(
    isCanceledNavigation(undefined, undefined, new Error("Error: (-3) loading 'https://example.test/'")),
    true
  );
  assert.equal(
    isCanceledNavigation(undefined, undefined, new Error("net::ERR_ABORTED")),
    true
  );
});

test("does not suppress real page-load failures", () => {
  assert.equal(isCanceledNavigation(-105, "ERR_NAME_NOT_RESOLVED"), false);
  assert.equal(
    isCanceledNavigation(undefined, undefined, new Error("ERR_CONNECTION_TIMED_OUT")),
    false
  );
});
