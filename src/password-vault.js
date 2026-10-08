const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MASTER_MIN_LENGTH = 12;
const MASTER_MAX_LENGTH = 1024;
const RECOVERY_PIN_PATTERN = /^\d{4,6}$/;
const MAX_RECOVERY_DELAY_MS = 60 * 60 * 1000;

function ensureEncryptionAvailable(safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Operating-system password encryption is unavailable.");
  }
}

function deriveKey(secret, salt) {
  return scrypt(secret, salt, 32, SCRYPT_OPTIONS);
}

function encryptWithKey(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptWithKey(encrypted, key) {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    throw new Error("The master password or encrypted password vault is invalid.", {
      cause: error
    });
  }
}

function readFile(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value.version !== 1 && value.version !== 2) {
      throw new Error("The encrypted password vault has an unsupported format.");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read the encrypted password vault: ${error.message}`, {
      cause: error
    });
  }
}

function decryptLegacyCredentials(value, safeStorage) {
  ensureEncryptionAvailable(safeStorage);
  const plaintext = safeStorage.decryptString(
    Buffer.from(value.encryptedCredentials, "base64")
  );
  const credentials = JSON.parse(plaintext);
  if (!Array.isArray(credentials)) {
    throw new Error("The encrypted password vault has an invalid format.");
  }
  return credentials;
}

function decryptDeviceKey(value, safeStorage) {
  ensureEncryptionAvailable(safeStorage);
  try {
    const encodedKey = safeStorage.decryptString(
      Buffer.from(value.deviceEncryptedKey, "base64")
    );
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) throw new Error("Invalid device key.");
    return key;
  } catch (error) {
    throw new Error("Could not unlock the password vault with OS secure storage.", {
      cause: error
    });
  }
}

function decryptCredentials(value, key) {
  const credentials = JSON.parse(decryptWithKey(value.encryptedCredentials, key));
  if (!Array.isArray(credentials)) {
    throw new Error("The encrypted password vault has an invalid format.");
  }
  return credentials;
}

function decryptRecoveryState(value, safeStorage) {
  ensureEncryptionAvailable(safeStorage);
  try {
    const plaintext = safeStorage.decryptString(
      Buffer.from(value.deviceEncryptedRecovery, "base64")
    );
    const state = JSON.parse(plaintext);
    if (
      typeof state.salt !== "string" ||
      typeof state.verifier !== "string" ||
      !Number.isInteger(state.failedAttempts) ||
      !Number.isFinite(state.lockedUntil)
    ) {
      throw new Error("Invalid recovery state.");
    }
    return state;
  } catch (error) {
    throw new Error("Could not read the password vault recovery state.", {
      cause: error
    });
  }
}

function writeAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function validateMasterPassword(password, confirmation) {
  if (typeof password !== "string" || password.length < MASTER_MIN_LENGTH) {
    throw new Error(`Master password must be at least ${MASTER_MIN_LENGTH} characters.`);
  }
  if (Buffer.byteLength(password, "utf8") > MASTER_MAX_LENGTH) {
    throw new Error("Master password is too long.");
  }
  if (password !== confirmation) {
    throw new Error("Master passwords do not match.");
  }
}

function validateRecoveryPin(pin, confirmation) {
  if (typeof pin !== "string" || !RECOVERY_PIN_PATTERN.test(pin)) {
    throw new Error("Recovery PIN must contain 4 to 6 digits.");
  }
  if (pin !== confirmation) {
    throw new Error("Recovery PINs do not match.");
  }
}

function createPasswordVault(filePath, safeStorage) {
  let managerUnlocked = false;
  let masterFailures = 0;
  let masterLockedUntil = 0;

  function currentCredentials() {
    ensureEncryptionAvailable(safeStorage);
    const value = readFile(filePath);
    if (!value) return [];
    if (value.version === 1) return decryptLegacyCredentials(value, safeStorage);
    const key = decryptDeviceKey(value, safeStorage);
    try {
      return decryptCredentials(value, key);
    } finally {
      key.fill(0);
    }
  }

  function deviceKey(value = readFile(filePath)) {
    if (!value || value.version !== 2) {
      throw new Error("The password manager has not been set up.");
    }
    return decryptDeviceKey(value, safeStorage);
  }

  function writeCredentials(credentials) {
    const value = readFile(filePath);
    if (!value || value.version === 1) {
      ensureEncryptionAvailable(safeStorage);
      const encryptedCredentials = safeStorage
        .encryptString(JSON.stringify(credentials))
        .toString("base64");
      writeAtomically(filePath, { version: 1, encryptedCredentials });
      return;
    }
    const key = deviceKey(value);
    try {
      writeAtomically(filePath, {
        ...value,
        encryptedCredentials: encryptWithKey(JSON.stringify(credentials), key)
      });
    } finally {
      key.fill(0);
    }
  }

  function requireManagerUnlock() {
    if (!managerUnlocked) {
      throw new Error("Unlock the password manager before viewing saved passwords.");
    }
  }

  function listCredentials(origin) {
    return currentCredentials()
      .filter((credential) => !origin || credential.origin === origin)
      .map(({ id, origin: site, username, updatedAt }) => ({
        id,
        origin: site,
        username,
        updatedAt
      }));
  }

  function removeCredential(id) {
    const credentials = currentCredentials();
    const nextCredentials = credentials.filter((item) => item.id !== id);
    if (nextCredentials.length === credentials.length) return false;
    writeCredentials(nextCredentials);
    return true;
  }

  return {
    status() {
      const value = readFile(filePath);
      return {
        configured: value?.version === 2,
        hasLegacyCredentials: value?.version === 1 &&
          decryptLegacyCredentials(value, safeStorage).length > 0
      };
    },
    async setup({
      masterPassword,
      masterPasswordConfirmation,
      recoveryPin,
      recoveryPinConfirmation
    }) {
      ensureEncryptionAvailable(safeStorage);
      validateMasterPassword(masterPassword, masterPasswordConfirmation);
      validateRecoveryPin(recoveryPin, recoveryPinConfirmation);
      const existing = readFile(filePath);
      if (existing?.version === 2) {
        throw new Error("The password manager is already set up.");
      }
      const credentials = existing?.version === 1
        ? decryptLegacyCredentials(existing, safeStorage)
        : [];
      const dataKey = crypto.randomBytes(32);
      const masterSalt = crypto.randomBytes(16);
      const recoverySalt = crypto.randomBytes(16);
      let masterKey;
      let recoveryVerifier;
      try {
        masterKey = await deriveKey(masterPassword, masterSalt);
        recoveryVerifier = await deriveKey(recoveryPin, recoverySalt);
        const recoveryState = {
          salt: recoverySalt.toString("base64"),
          verifier: recoveryVerifier.toString("base64"),
          failedAttempts: 0,
          lockedUntil: 0
        };
        const value = {
          version: 2,
          masterSalt: masterSalt.toString("base64"),
          masterEncryptedKey: encryptWithKey(dataKey.toString("base64"), masterKey),
          deviceEncryptedKey: safeStorage.encryptString(dataKey.toString("base64"))
            .toString("base64"),
          deviceEncryptedRecovery: safeStorage.encryptString(JSON.stringify(recoveryState))
            .toString("base64"),
          encryptedCredentials: encryptWithKey(JSON.stringify(credentials), dataKey)
        };
        writeAtomically(filePath, value);
      } finally {
        dataKey.fill(0);
        masterKey?.fill(0);
        recoveryVerifier?.fill(0);
      }
      managerUnlocked = true;
      masterFailures = 0;
      masterLockedUntil = 0;
      return { credentialCount: credentials.length };
    },
    async unlock(masterPassword) {
      const value = readFile(filePath);
      if (value?.version !== 2) {
        throw new Error("Set up the password manager before unlocking it.");
      }
      const now = Date.now();
      if (now < masterLockedUntil) {
        throw new Error("Too many incorrect master passwords. Try again later.");
      }
      let key;
      let masterKey;
      try {
        masterKey = await deriveKey(
          masterPassword,
          Buffer.from(value.masterSalt, "base64")
        );
        key = Buffer.from(
          decryptWithKey(value.masterEncryptedKey, masterKey),
          "base64"
        );
        if (key.length !== 32) throw new Error("Invalid master key.");
      } catch {
        key?.fill(0);
        masterFailures += 1;
        if (masterFailures >= 5) {
          masterLockedUntil = Date.now() + Math.min(
            60_000 * 2 ** (masterFailures - 5),
            MAX_RECOVERY_DELAY_MS
          );
        }
        throw new Error("Incorrect master password.");
      } finally {
        masterKey?.fill(0);
      }
      let osKey;
      let keysMatch;
      try {
        osKey = decryptDeviceKey(value, safeStorage);
        keysMatch = key.length === osKey.length &&
          crypto.timingSafeEqual(key, osKey);
      } finally {
        key.fill(0);
        osKey?.fill(0);
      }
      if (!keysMatch) {
        throw new Error("The password vault key is inconsistent.");
      }
      masterFailures = 0;
      masterLockedUntil = 0;
      managerUnlocked = true;
      return true;
    },
    async recover({
      recoveryPin,
      masterPassword,
      masterPasswordConfirmation
    }) {
      const value = readFile(filePath);
      if (value?.version !== 2) {
        throw new Error("Set up the password manager before recovery.");
      }
      validateMasterPassword(masterPassword, masterPasswordConfirmation);
      if (typeof recoveryPin !== "string" || !RECOVERY_PIN_PATTERN.test(recoveryPin)) {
        throw new Error("Recovery PIN must contain 4 to 6 digits.");
      }
      const state = decryptRecoveryState(value, safeStorage);
      const now = Date.now();
      if (now < state.lockedUntil) {
        const remainingSeconds = Math.ceil((state.lockedUntil - now) / 1000);
        throw new Error(`Recovery is temporarily locked. Try again in ${remainingSeconds} seconds.`);
      }
      const attempt = await deriveKey(recoveryPin, Buffer.from(state.salt, "base64"));
      const expected = Buffer.from(state.verifier, "base64");
      let matches;
      try {
        matches = attempt.length === expected.length &&
          crypto.timingSafeEqual(attempt, expected);
      } finally {
        attempt.fill(0);
        expected.fill(0);
      }
      if (!matches) {
        state.failedAttempts += 1;
        if (state.failedAttempts >= 3) {
          state.lockedUntil = Date.now() + Math.min(
            30_000 * 2 ** (state.failedAttempts - 3),
            MAX_RECOVERY_DELAY_MS
          );
        }
        value.deviceEncryptedRecovery = safeStorage
          .encryptString(JSON.stringify(state))
          .toString("base64");
        writeAtomically(filePath, value);
        throw new Error(state.failedAttempts >= 3
          ? "Incorrect recovery PIN. Recovery is temporarily locked."
          : "Incorrect recovery PIN.");
      }
      const masterSalt = crypto.randomBytes(16);
      const masterKey = await deriveKey(masterPassword, masterSalt);
      const dataKey = decryptDeviceKey(value, safeStorage);
      try {
        value.masterSalt = masterSalt.toString("base64");
        value.masterEncryptedKey = encryptWithKey(dataKey.toString("base64"), masterKey);
        value.deviceEncryptedRecovery = safeStorage.encryptString(JSON.stringify({
          ...state,
          failedAttempts: 0,
          lockedUntil: 0
        })).toString("base64");
        writeAtomically(filePath, value);
      } finally {
        masterKey.fill(0);
        dataKey.fill(0);
      }
      managerUnlocked = true;
      masterFailures = 0;
      masterLockedUntil = 0;
      return true;
    },
    lockManager() {
      managerUnlocked = false;
    },
    list(origin) {
      return listCredentials(origin);
    },
    listForManager() {
      requireManagerUnlock();
      return listCredentials();
    },
    revealForManager(id) {
      requireManagerUnlock();
      const credential = currentCredentials().find((item) => item.id === id);
      if (!credential) return null;
      return {
        origin: credential.origin,
        username: credential.username,
        password: credential.password
      };
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
      const credentials = currentCredentials();
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
      writeCredentials(nextCredentials);
      return { id: credential.id, origin: credential.origin, username: credential.username };
    },
    get({ id, origin }) {
      return currentCredentials().find(
        (credential) => credential.id === id && credential.origin === origin
      ) || null;
    },
    remove(id) {
      return removeCredential(id);
    },
    removeForManager(id) {
      requireManagerUnlock();
      return removeCredential(id);
    }
  };
}

module.exports = { createPasswordVault };
