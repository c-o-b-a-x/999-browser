const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const REMOTE_CHANGELOG_URL =
  "https://raw.githubusercontent.com/c-o-b-a-x/999-browser/main/CHANGELOG.md";
const MAX_CHANGELOG_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function normalizeChangelog(markdown) {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown, "utf8") > MAX_CHANGELOG_BYTES) {
    throw new Error("The changelog is invalid or too large.");
  }
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!/^# Changelog(?:\s|$)/i.test(normalized)) {
    throw new Error("The changelog has an unsupported format.");
  }
  return `${normalized}\n`;
}

function hashChangelog(markdown) {
  return crypto.createHash("sha256").update(normalizeChangelog(markdown)).digest("hex");
}

function fetchRemoteChangelog(etag) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: "text/plain" };
    if (typeof etag === "string" && etag.length <= 512) {
      headers["If-None-Match"] = etag;
    }
    const request = https.get(REMOTE_CHANGELOG_URL, { headers }, (response) => {
      if (response.statusCode === 304) {
        response.resume();
        resolve({ notModified: true, etag: response.headers.etag || etag });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`The changelog server returned HTTP ${response.statusCode}.`));
        return;
      }
      const chunks = [];
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_CHANGELOG_BYTES) {
          request.destroy(new Error("The remote changelog exceeds the size limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const markdown = normalizeChangelog(Buffer.concat(chunks).toString("utf8"));
          resolve({ markdown, etag: response.headers.etag || null });
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("The changelog request timed out."));
    });
    request.on("error", reject);
  });
}

function writeStateAtomically(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function readState(statePath, initialHash) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (
      typeof state.enabled !== "boolean" ||
      (state.lastSeenHash !== null && !HASH_PATTERN.test(state.lastSeenHash)) ||
      (state.remoteHash !== null && !HASH_PATTERN.test(state.remoteHash)) ||
      (state.remoteMarkdown !== null && typeof state.remoteMarkdown !== "string") ||
      (state.etag !== null && typeof state.etag !== "string")
    ) {
      throw new Error("The changelog preferences have an invalid format.");
    }
    if (
      state.remoteMarkdown !== null &&
      hashChangelog(state.remoteMarkdown) !== state.remoteHash
    ) {
      throw new Error("The cached changelog does not match its saved checksum.");
    }
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read changelog preferences: ${error.message}`, {
        cause: error
      });
    }
    const initialState = {
      enabled: true,
      lastSeenHash: initialHash,
      remoteHash: null,
      remoteMarkdown: null,
      etag: null
    };
    writeStateAtomically(statePath, initialState);
    return initialState;
  }
}

function createChangelogUpdates({
  statePath,
  changelogPath,
  fetchRemote = fetchRemoteChangelog
}) {
  const localChangelog = normalizeChangelog(fs.readFileSync(changelogPath, "utf8"));
  const state = readState(statePath, hashChangelog(localChangelog));

  return {
    isEnabled() {
      return state.enabled;
    },
    setEnabled(enabled) {
      if (typeof enabled !== "boolean") {
        throw new TypeError("Changelog update preference must be boolean.");
      }
      state.enabled = enabled;
      writeStateAtomically(statePath, state);
      return state.enabled;
    },
    markSeen(hash) {
      if (
        typeof hash !== "string" ||
        !HASH_PATTERN.test(hash) ||
        hash !== state.remoteHash
      ) {
        throw new Error("The changelog update is no longer current.");
      }
      state.lastSeenHash = hash;
      writeStateAtomically(statePath, state);
      return true;
    },
    async check() {
      if (!state.enabled) return null;
      let remote = await fetchRemote(state.etag);
      if (remote.notModified) {
        if (!state.remoteMarkdown) {
          remote = await fetchRemote(null);
        } else {
          remote = {
            markdown: state.remoteMarkdown,
            etag: remote.etag || state.etag
          };
        }
      }
      const markdown = normalizeChangelog(remote.markdown);
      const hash = hashChangelog(markdown);
      state.remoteHash = hash;
      state.remoteMarkdown = markdown;
      state.etag = typeof remote.etag === "string" ? remote.etag : null;
      writeStateAtomically(statePath, state);
      return hash === state.lastSeenHash ? null : { markdown, hash };
    }
  };
}

module.exports = {
  createChangelogUpdates,
  fetchRemoteChangelog,
  hashChangelog,
  normalizeChangelog
};
