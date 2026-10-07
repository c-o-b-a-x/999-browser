const test = require("node:test");
const assert = require("node:assert/strict");
const { isTrackerUrl, normalizeAddress } = require("../src/privacy");

test("normalizes website addresses and searches non-address input", () => {
  assert.equal(normalizeAddress("example.com"), "https://example.com/");
  assert.equal(normalizeAddress("localhost:3000"), "https://localhost:3000/");
  assert.equal(normalizeAddress("example.com:8080/path"), "https://example.com:8080/path");
  assert.equal(normalizeAddress("http://example.com"), "http://example.com/");
  assert.equal(
    normalizeAddress("weather"),
    "https://duckduckgo.com/?q=weather"
  );
  assert.equal(
    normalizeAddress("weather forecast"),
    "https://duckduckgo.com/?q=weather%20forecast"
  );
  assert.equal(
    normalizeAddress("example.com/search?q=weather"),
    "https://example.com/search?q=weather"
  );
  assert.equal(
    normalizeAddress("privacy search"),
    "https://duckduckgo.com/?q=privacy%20search"
  );
  assert.equal(normalizeAddress(""), "");
});

test("rejects non-web protocols by treating them as search text", () => {
  assert.equal(
    normalizeAddress("file:///private.txt"),
    "https://duckduckgo.com/?q=file%3A%2F%2F%2Fprivate.txt"
  );
});

test("blocks listed tracker hosts and their subdomains only", () => {
  assert.equal(isTrackerUrl("https://www.google-analytics.com/collect"), true);
  assert.equal(isTrackerUrl("https://analytics.google-analytics.com/pixel"), true);
  assert.equal(isTrackerUrl("https://notgoogle-analytics.com/"), false);
  assert.equal(isTrackerUrl("https://example.com/"), false);
  assert.equal(isTrackerUrl("not a url"), false);
});
