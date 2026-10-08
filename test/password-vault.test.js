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
  return {
    directory,
    filePath,
    safeStorage,
    vault: createPasswordVault(filePath, safeStorage)
  };
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

test("sets up a master password and migrates the OS-encrypted legacy vault", async (t) => {
  const { directory, filePath, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = vault.save({
    origin: "https://example.test",
    username: "alice",
    password: "migrated-secret"
  });

  const result = await vault.setup({
    masterPassword: "a-long-master-password",
    masterPasswordConfirmation: "a-long-master-password",
    recoveryPin: "123456",
    recoveryPinConfirmation: "123456"
  });
  assert.equal(result.credentialCount, 1);
  assert.deepEqual(vault.status(), { configured: true, hasLegacyCredentials: false });
  assert.equal(vault.listForManager()[0].id, saved.id);
  assert.equal(vault.revealForManager(saved.id).password, "migrated-secret");
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 2);
  const savedVault = fs.readFileSync(filePath, "utf8");
  assert.equal(savedVault.includes("migrated-secret"), false);
  assert.equal(savedVault.includes("123456"), false);
});

test("requires the master password for manager listing and revealing", async (t) => {
  const { directory, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = vault.save({
    origin: "https://example.test",
    username: "alice",
    password: "hidden-value"
  });
  await vault.setup({
    masterPassword: "another-long-master-password",
    masterPasswordConfirmation: "another-long-master-password",
    recoveryPin: "1234",
    recoveryPinConfirmation: "1234"
  });
  vault.lockManager();
  assert.throws(() => vault.listForManager(), /Unlock the password manager/);
  assert.throws(() => vault.revealForManager(saved.id), /Unlock the password manager/);
  await assert.rejects(vault.unlock("not-the-right-password"), /Incorrect master password/);
  await vault.unlock("another-long-master-password");
  assert.equal(vault.revealForManager(saved.id).password, "hidden-value");
  vault.lockManager();
  assert.throws(() => vault.listForManager(), /Unlock the password manager/);
});

test("keeps origin-bound autofill data available while the manager is locked", async (t) => {
  const { directory, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = vault.save({
    origin: "https://example.test",
    username: "alice",
    password: "autofill-only-after-confirmation"
  });
  await vault.setup({
    masterPassword: "autofill-master-password",
    masterPasswordConfirmation: "autofill-master-password",
    recoveryPin: "2468",
    recoveryPinConfirmation: "2468"
  });
  vault.lockManager();
  assert.equal(vault.list("https://example.test")[0].id, saved.id);
  assert.equal(
    vault.get({ id: saved.id, origin: "https://example.test" }).password,
    "autofill-only-after-confirmation"
  );
  assert.throws(() => vault.removeForManager(saved.id), /Unlock the password manager/);
});

test("recovers with the backup PIN and resets the master password", async (t) => {
  const { directory, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = vault.save({
    origin: "https://example.test",
    username: "alice",
    password: "preserved-password"
  });
  await vault.setup({
    masterPassword: "original-master-password",
    masterPasswordConfirmation: "original-master-password",
    recoveryPin: "5678",
    recoveryPinConfirmation: "5678"
  });
  vault.lockManager();
  await assert.rejects(
    vault.recover({
      recoveryPin: "1111",
      masterPassword: "replacement-master-password",
      masterPasswordConfirmation: "replacement-master-password"
    }),
    /Incorrect recovery PIN/
  );
  await vault.recover({
    recoveryPin: "5678",
    masterPassword: "replacement-master-password",
    masterPasswordConfirmation: "replacement-master-password"
  });
  assert.equal(vault.revealForManager(saved.id).password, "preserved-password");
  vault.lockManager();
  await assert.rejects(vault.unlock("original-master-password"), /Incorrect master password/);
  await vault.unlock("replacement-master-password");
  assert.equal(vault.revealForManager(saved.id).password, "preserved-password");
});

test("validates master passwords and throttles repeated recovery PIN failures", async (t) => {
  const { directory, filePath, safeStorage, vault } = makeVault();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    vault.setup({
      masterPassword: "short",
      masterPasswordConfirmation: "short",
      recoveryPin: "1234",
      recoveryPinConfirmation: "1234"
    }),
    /at least 12 characters/
  );
  await vault.setup({
    masterPassword: "strong-master-password",
    masterPasswordConfirmation: "strong-master-password",
    recoveryPin: "1234",
    recoveryPinConfirmation: "1234"
  });
  vault.lockManager();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      vault.recover({
        recoveryPin: "9999",
        masterPassword: "replacement-master-password",
        masterPasswordConfirmation: "replacement-master-password"
      }),
      /Incorrect recovery PIN/
    );
  }
  await assert.rejects(
    vault.recover({
      recoveryPin: "1234",
      masterPassword: "replacement-master-password",
      masterPasswordConfirmation: "replacement-master-password"
    }),
    /temporarily locked/
  );
  const storedVault = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const recoveryState = JSON.parse(safeStorage.decryptString(
    Buffer.from(storedVault.deviceEncryptedRecovery, "base64")
  ));
  assert.equal(recoveryState.failedAttempts, 3);
  assert.ok(recoveryState.lockedUntil > Date.now());
  const restartedVault = createPasswordVault(filePath, safeStorage);
  await assert.rejects(
    restartedVault.recover({
      recoveryPin: "1234",
      masterPassword: "replacement-master-password",
      masterPasswordConfirmation: "replacement-master-password"
    }),
    /temporarily locked/
  );
});
