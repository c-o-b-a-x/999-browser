const fs = require("node:fs");
const path = require("node:path");

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 3;
let logDirectory = null;
let logFile = null;

function safeOrigin(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/[redacted]`;
  } catch {
    return "[redacted-url]";
  }
}

function sanitizeText(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/gi, safeOrigin);
}

function sanitizeDetails(value, key = "", depth = 0) {
  if (/cookie|authorization|token|password|secret|query|search|address|url|title|content|body/i.test(key)) {
    return typeof value === "string" ? safeOrigin(value) : "[redacted]";
  }
  if (depth > 4) return "[depth-limit]";
  if (value instanceof Error) {
    return {
      name: sanitizeText(value.name),
      message: sanitizeText(value.message),
      stack: sanitizeText(value.stack || "")
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeDetails(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([childKey, childValue]) => [
          childKey,
          sanitizeDetails(childValue, childKey, depth + 1)
        ])
    );
  }
  if (typeof value === "string") return sanitizeText(value.slice(0, 4000));
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return String(value);
}

function configureLogger(directory) {
  logDirectory = directory;
  logFile = path.join(directory, "quiet-browser.log");
  fs.mkdirSync(directory, { recursive: true });
  writeLog("info", "logging.initialized", {
    fileName: path.basename(logFile),
    maxBytes: MAX_LOG_BYTES,
    rotatedFiles: MAX_ROTATED_FILES
  });
}

function rotateLogsIfNeeded() {
  if (!logFile || !fs.existsSync(logFile)) return;
  if (fs.statSync(logFile).size < MAX_LOG_BYTES) return;

  for (let index = MAX_ROTATED_FILES; index >= 1; index -= 1) {
    const source = index === 1 ? logFile : `${logFile}.${index - 1}`;
    const destination = `${logFile}.${index}`;
    if (index === MAX_ROTATED_FILES && fs.existsSync(destination)) {
      fs.unlinkSync(destination);
    }
    if (fs.existsSync(source)) fs.renameSync(source, destination);
  }
}

function writeLog(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event: sanitizeText(event),
    processId: process.pid,
    details: sanitizeDetails(details)
  };
  const line = JSON.stringify(entry);
  const consoleMethod = level === "error" || level === "fatal" ? "error" :
    level === "warn" ? "warn" : "log";
  console[consoleMethod](`[${entry.timestamp}] ${level.toUpperCase()} ${entry.event}`, entry.details);

  if (!logFile) return;
  try {
    rotateLogsIfNeeded();
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write browser diagnostic log:", error);
  }
}

function getLogDirectory() {
  return logDirectory;
}

module.exports = {
  configureLogger,
  getLogDirectory,
  safeOrigin,
  sanitizeDetails,
  sanitizeText,
  writeLog
};
