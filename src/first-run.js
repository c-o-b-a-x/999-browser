const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function shouldShowFirstRun(markerPath, existingDataPaths) {
  if (fs.existsSync(markerPath)) return false;
  return !existingDataPaths.some((filePath) => fs.existsSync(filePath));
}

function markFirstRunComplete(markerPath) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const temporaryPath = `${markerPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, "completed\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporaryPath, markerPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

module.exports = { markFirstRunComplete, shouldShowFirstRun };
