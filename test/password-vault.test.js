const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPasswordVault } = require("../src/password-vault");

function makeVault() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-browser-vault-"));
  const filePath = path.join(directory, "vault.json");
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split("").reverse().join("")),
    decryptString: (value) => value.toString().split("").reverse().join("")
  };
  return { directory, filePath, vault: createPasswordVault(filePath, safeStorage) };
}

test("stores credentials encrypted and reveals only credential metadata", (t) => {
  const { directory, filePath, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = vault.save({
    origin: "https://example.test/login",
    username: "user@example.test",
    password: "never-write-this-plaintext"
  });
  const file = fs.readFileSync(filePath, "utf8");
  assert.equal(file.includes("never-write-this-plaintext"), false);
  const metadata = vault.list("https://example.test");
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].id, saved.id);
  assert.equal(metadata[0].origin, "https://example.test");
  assert.equal(metadata[0].username, "user@example.test");
  assert.equal("password" in metadata[0], false);
  assert.equal(
    vault.get({ id: saved.id, origin: "https://example.test" }).password,
    "never-write-this-plaintext"
  );
});

test("requires OS encryption and restricts insecure origins", (t) => {
  const { directory, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => vault.save({ origin: "http://example.test", username: "user", password: "pw" }),
    /HTTPS sites or localhost/
  );
  const noEncryption = createPasswordVault(path.join(directory, "unavailable.json"), {
    isEncryptionAvailable: () => false
  });
  assert.throws(() => noEncryption.list(), /encryption is unavailable/);
});

test("updates and removes credentials without exposing stored passwords in listings", (t) => {
  const { directory, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = vault.save({ origin: "https://example.test", username: "alice", password: "one" });
  const updated = vault.save({ origin: "https://example.test", username: "alice", password: "two" });
  assert.equal(updated.id, first.id);
  assert.equal(vault.get({ id: first.id, origin: "https://example.test" }).password, "two");
  assert.equal(vault.remove(first.id), true);
  assert.equal(vault.remove(first.id), false);
});
