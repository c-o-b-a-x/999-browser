const test = require("node:test");
const assert = require("node:assert/strict");
const { createFilterEngine } = require("../src/adblock");

test("matches host, path, and resource-type filters", () => {
  const engine = createFilterEngine([
    "||ads.example.test^",
    "||/pagead/ad*",
    "/banner-[0-9]+\\.js/$script",
    "/pixel.gif$image",
    "/api/ad-data$xmlhttprequest"
  ]);
  assert.equal(
    engine.shouldBlock("https://cdn.ads.example.test/slot", "https://news.test/", "script"),
    true
  );
  assert.equal(
    engine.shouldBlock("https://assets.test/banner-42.js", "https://news.test/", "script"),
    true
  );
  assert.equal(
    engine.shouldBlock("https://assets.test/banner-42.js", "https://news.test/", "image"),
    false
  );
  assert.equal(
    engine.shouldBlock("https://assets.test/pixel.gif", "https://news.test/", "image"),
    true
  );
  assert.equal(
    engine.shouldBlock("http://localhost:8765/pagead/ad", "http://localhost:8765/", "image"),
    true
  );
  assert.equal(
    engine.shouldBlock("https://api.test/api/ad-data", "https://news.test/", "xhr"),
    true
  );
});

test("supports exceptions, domains, and third-party conditions", () => {
  const engine = createFilterEngine([
    "||ads.example.test^$third-party",
    "@@||ads.example.test/allow^",
    "/sponsor/$domain=publisher.test|~allowed.publisher.test"
  ]);
  assert.equal(
    engine.shouldBlock("https://ads.example.test/ad", "https://publisher.test/", "image"),
    true
  );
  assert.equal(
    engine.shouldBlock("https://ads.example.test/ad", "https://example.test/", "image"),
    false
  );
  assert.equal(
    engine.shouldBlock("https://ads.example.test/allow", "https://publisher.test/", "image"),
    false
  );
  assert.equal(
    engine.shouldBlock("https://cdn.test/sponsor/banner", "https://publisher.test/", "image"),
    true
  );
  assert.equal(
    engine.shouldBlock("https://cdn.test/sponsor/banner", "https://allowed.publisher.test/", "image"),
    false
  );
});
