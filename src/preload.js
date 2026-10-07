const { contextBridge, ipcRenderer } = require("electron");

function serializeDiagnostic(value, depth = 0) {
  if (depth > 4) return "[depth-limit]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => serializeDiagnostic(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, child]) => [key, serializeDiagnostic(child, depth + 1)])
    );
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  return String(value);
}

function log(level, event, details = {}) {
  ipcRenderer.send("diagnostic:log", {
    level,
    event: String(event).slice(0, 120),
    details: serializeDiagnostic(details)
  });
}

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("quietBrowser", {
  loadData: () => ipcRenderer.invoke("data:load"),
  addHistory: (entry) => ipcRenderer.invoke("data:add-history", entry),
  addBookmark: (entry) => ipcRenderer.invoke("data:add-bookmark", entry),
  removeBookmark: (url) => ipcRenderer.invoke("data:remove-bookmark", url),
  clearBrowsingData: () => ipcRenderer.invoke("data:clear"),
  openLogsFolder: () => ipcRenderer.invoke("diagnostic:open-folder"),
  listPasswords: (request) => ipcRenderer.invoke("password:list", request),
  savePassword: (candidate) => ipcRenderer.invoke("password:save", candidate),
  retrievePassword: (request) => ipcRenderer.invoke("password:retrieve", request),
  removePassword: (id) => ipcRenderer.invoke("password:remove", id),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveTheme: (theme) => ipcRenderer.invoke("settings:save-theme", theme),
  setAdBlocking: (enabled) => ipcRenderer.invoke("settings:set-adblocking", enabled),
  onPasswordSavePrompt: (callback) => subscribe("password:save-prompt", callback),
  log
});
