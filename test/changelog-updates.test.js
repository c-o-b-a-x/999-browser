const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createChangelogUpdates,
  hashChangelog,
  normalizeChangelog
} = require("../src/changelog-updates");

function makeUpdates(t, fetchRemote) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "no-peepers-changelog-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const changelogPath = path.join(directory, "CHANGELOG.md");
  const statePath = path.join(directory, "changelog-settings.json");
  fs.writeFileSync(changelogPath, "# Changelog\n\n## 2026-10-08\n\n- Existing note.\n");
  return {
    directory,
    statePath,
    updates: createChangelogUpdates({ statePath, changelogPath, fetchRemote })
  };
}

test("normalizes changelog line endings and rejects non-changelog content", () => {
  assert.equal(normalizeChangelog("\uFEFF# Changelog\r\n\r\n- Note.\r\n"), "# Changelog\n\n- Note.\n");
  assert.throws(() => normalizeChangelog("<html>not notes</html>"), /unsupported format/);
});

test("shows unseen remote changelog once and acknowledges its content hash", async (t) => {
  const remoteMarkdown = "# Changelog\n\n## 2026-10-09\n\n- A new feature.\n";
  const requests = [];
  const { updates, statePath } = makeUpdates(t, async (etag) => {
    requests.push(etag);
    return { markdown: remoteMarkdown, etag: '"release-2"' };
  });

  const update = await updates.check();
  assert.equal(update.markdown, remoteMarkdown);
  assert.equal(update.hash, hashChangelog(remoteMarkdown));
  assert.deepEqual(requests, [null]);
  assert.equal(updates.markSeen(update.hash), true);
  assert.equal(await updates.check(), null);
  assert.deepEqual(requests, [null, '"release-2"']);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).lastSeenHash, update.hash);
});

test("uses the cached changelog for an unchanged ETag response", async (t) => {
  const remoteMarkdown = "# Changelog\n\n## 2026-10-09\n\n- Cached notes.\n";
  let requestCount = 0;
  const { updates } = makeUpdates(t, async (etag) => {
    requestCount += 1;
    if (etag) return { notModified: true, etag };
    return { markdown: remoteMarkdown, etag: '"release-3"' };
  });

  const first = await updates.check();
  updates.markSeen(first.hash);
  assert.equal(await updates.check(), null);
  assert.equal(requestCount, 2);
});

test("opt-out persists and prevents remote checks until re-enabled", async (t) => {
  let requestCount = 0;
  const { updates, statePath } = makeUpdates(t, async () => {
    requestCount += 1;
    return { markdown: "# Changelog\n\n- New note.\n", etag: null };
  });

  assert.equal(updates.setEnabled(false), false);
  assert.equal(await updates.check(), null);
  assert.equal(requestCount, 0);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).enabled, false);
  assert.equal(updates.setEnabled(true), true);
  assert.ok(await updates.check());
  assert.equal(requestCount, 1);
});

test("rejects stale acknowledgements and malformed remote content", async (t) => {
  const { updates } = makeUpdates(t, async () => ({
    markdown: "# Changelog\n\n- Current note.\n",
    etag: null
  }));
  const current = await updates.check();
  assert.throws(() => updates.markSeen("0".repeat(64)), /no longer current/);
  assert.equal(updates.markSeen(current.hash), true);

  const malformed = makeUpdates(t, async () => ({
    markdown: "<html>unexpected response</html>",
    etag: null
  }));
  await assert.rejects(
    malformed.updates.check(),
    /unsupported format/
  );
});
