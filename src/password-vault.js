const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function ensureEncryptionAvailable(safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Operating-system password encryption is unavailable.");
  }
}

function readCredentials(filePath, safeStorage) {
  ensureEncryptionAvailable(safeStorage);
  try {
    const encrypted = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(encrypted);
    const plaintext = safeStorage.decryptString(
      Buffer.from(parsed.encryptedCredentials, "base64")
    );
    const credentials = JSON.parse(plaintext);
    if (!Array.isArray(credentials)) {
      throw new Error("The encrypted password vault has an invalid format.");
    }
    return credentials;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Could not read the encrypted password vault: ${error.message}`, {
      cause: error
    });
  }
}

function writeCredentials(filePath, safeStorage, credentials) {
  ensureEncryptionAvailable(safeStorage);
  const encryptedCredentials = safeStorage
    .encryptString(JSON.stringify(credentials))
    .toString("base64");
  const temporaryPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify({ version: 1, encryptedCredentials }),
    { encoding: "utf8", mode: 0o600 }
  );
  fs.renameSync(temporaryPath, filePath);
}

function createPasswordVault(filePath, safeStorage) {
  return {
    list(origin) {
      return readCredentials(filePath, safeStorage)
        .filter((credential) => !origin || credential.origin === origin)
        .map(({ id, origin: site, username, updatedAt }) => ({
          id,
          origin: site,
          username,
          updatedAt
        }));
    },
    save({ origin, username, password }) {
      if (!/^https:\/\//i.test(origin) && !/^http:\/\/localhost(?::\d+)?$/i.test(origin)) {
        throw new Error("Passwords can only be saved for HTTPS sites or localhost.");
      }
      const url = new URL(origin);
      const normalizedOrigin = url.origin;
      if (!username || !password) {
        throw new Error("A username and password are required.");
      }
      const credentials = readCredentials(filePath, safeStorage);
      const existing = credentials.find(
        (credential) =>
          credential.origin === normalizedOrigin && credential.username === username
      );
      const credential = {
        id: existing?.id || crypto.randomUUID(),
        origin: normalizedOrigin,
        username: String(username).slice(0, 300),
        password: String(password).slice(0, 2000),
        updatedAt: Date.now()
      };
      const nextCredentials = credentials.filter((item) => item.id !== credential.id);
      nextCredentials.push(credential);
      writeCredentials(filePath, safeStorage, nextCredentials);
      return { id: credential.id, origin: credential.origin, username: credential.username };
    },
    get({ id, origin }) {
      return readCredentials(filePath, safeStorage).find(
        (credential) => credential.id === id && credential.origin === origin
      ) || null;
    },
    remove(id) {
      const credentials = readCredentials(filePath, safeStorage);
      const nextCredentials = credentials.filter((credential) => credential.id !== id);
      if (nextCredentials.length === credentials.length) return false;
      writeCredentials(filePath, safeStorage, nextCredentials);
      return true;
    }
  };
}

module.exports = { createPasswordVault };
