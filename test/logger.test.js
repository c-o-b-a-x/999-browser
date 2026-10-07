const test = require("node:test");
const assert = require("node:assert/strict");
const { safeOrigin, sanitizeDetails, sanitizeText } = require("../src/logger");

test("redacts sensitive URL parts while preserving the site origin", () => {
  assert.equal(
    safeOrigin("https://user:pass@example.com/private/path?q=secret#fragment"),
    "https://example.com/[redacted]"
  );
  assert.equal(
    sanitizeText("Navigation failed at https://example.com/private?q=secret"),
    "Navigation failed at https://example.com/[redacted]"
  );
});

test("redacts sensitive detail fields and sanitizes errors", () => {
  const details = sanitizeDetails({
    query: "private search",
    cookie: "session-secret",
    origin: "https://example.com/private?q=secret",
    error: new Error("Failed at https://example.com/private?q=secret")
  });

  assert.equal(details.query, "[redacted-url]");
  assert.equal(details.cookie, "[redacted-url]");
  assert.equal(details.origin, "https://example.com/[redacted]");
  assert.equal(
    details.error.message,
    "Failed at https://example.com/[redacted]"
  );
});
