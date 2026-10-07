const { app, BrowserWindow, ipcMain, session, shell, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { isTrackerUrl } = require("./privacy");
const { configureLogger, getLogDirectory, safeOrigin, writeLog } = require("./logger");
const { createFilterEngine } = require("./adblock");
const { createPasswordVault } = require("./password-vault");
const { DEFAULT_THEME, mergeTheme, validateTheme } = require("./theme");

const BROWSER_PARTITION = "persist:quiet-browser";
const MAX_HISTORY_ITEMS = 1000;
const MAX_BOOKMARKS = 500;
let storePath;
let mainWebContentsId = null;
let mainWindow = null;
let passwordVault;
let adFilter;
let adBlockingEnabled = true;
const guestContents = new Map();

function readStore() {
  try {
    const value = JSON.parse(fs.readFileSync(storePath, "utf8"));
    writeLog("debug", "data.read.succeeded", {
      historyCount: Array.isArray(value.history) ? value.history.length : 0,
      bookmarkCount: Array.isArray(value.bookmarks) ? value.bookmarks.length : 0
    });
    return {
      history: Array.isArray(value.history) ? value.history : [],
      bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks : [],
      theme: mergeTheme(value.theme),
      adBlocking: value.adBlocking !== false
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      writeLog("error", "data.read.failed", { error });
      throw error;
    }
    writeLog("debug", "data.read.first-run", {});
    return { history: [], bookmarks: [] };
  }
}

function writeStore(store) {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(temporaryPath, storePath);
    writeLog("debug", "data.write.succeeded", {
      historyCount: store.history.length,
      bookmarkCount: store.bookmarks.length
    });
  } catch (error) {
    writeLog("error", "data.write.failed", { error });
    throw error;
  }
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function configureBrowserSession(browserSession) {
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    writeLog("info", "privacy.permission.denied", {
      permission,
      origin: safeOrigin(details?.requestingUrl || webContents.getURL())
    });
    callback(false);
  });
  browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    writeLog("debug", "privacy.permission-check.denied", {
      permission,
      origin: safeOrigin(requestingOrigin)
    });
    return false;
  });
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const blockedTracker = isTrackerUrl(details.url);
    const blockedAd = !blockedTracker && adBlockingEnabled && adFilter.shouldBlock(
      details.url,
      details.referrer || details.url,
      details.resourceType
    );
    if (blockedTracker || blockedAd) {
      writeLog("info", blockedTracker ? "privacy.tracker-blocked" : "privacy.ad-blocked", {
        origin: safeOrigin(details.url),
        resourceType: details.resourceType,
        method: details.method,
        firstParty: safeOrigin(details.referrer || details.url)
      });
    }
    callback({ cancel: blockedTracker || blockedAd });
  });
  browserSession.webRequest.onErrorOccurred((details) => {
    writeLog("warn", "network.request-failed", {
      origin: safeOrigin(details.url),
      method: details.method,
      resourceType: details.resourceType,
      error: details.error
    });
  });
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        DNT: "1",
        "Sec-GPC": "1"
      }
    });
  });
}

function registerDataHandlers(browserSession) {
  ipcMain.on("diagnostic:log", (event, entry) => {
    if (
      event.sender.id !== mainWebContentsId ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      writeLog("warn", "renderer.log-rejected", { reason: "untrusted-sender" });
      return;
    }
    const levels = ["debug", "info", "warn", "error", "fatal"];
    const level = levels.includes(entry?.level) ? entry.level : "info";
    writeLog(level, `renderer.${String(entry?.event || "unknown").slice(0, 120)}`, entry?.details);
  });

  ipcMain.handle("diagnostic:open-folder", async () => {
    const directory = getLogDirectory();
    writeLog("info", "logging.open-folder.requested", {});
    const error = await shell.openPath(directory);
    if (error) {
      writeLog("error", "logging.open-folder.failed", { error });
      throw new Error(error);
    }
  });

  function requireMainWindow(event) {
    if (event.sender.id !== mainWebContentsId || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("This operation is only available to the browser window.");
    }
  }

  function getTrustedGuest(webContentsId, origin) {
    const guest = guestContents.get(webContentsId);
    if (!guest || guest.isDestroyed()) {
      throw new Error("The browser tab is no longer available.");
    }
    let currentOrigin;
    try {
      currentOrigin = new URL(guest.getURL()).origin;
    } catch {
      throw new Error("The tab is not currently displaying a web page.");
    }
    if (currentOrigin !== origin) {
      throw new Error("The requested site does not match the active tab.");
    }
    return guest;
  }

  ipcMain.on("password:save-candidate", (event, candidate) => {
    const guest = guestContents.get(event.sender.id);
    if (
      !guest ||
      guest.isDestroyed() ||
      event.senderFrame !== guest.mainFrame
    ) return;
    let actualOrigin;
    try {
      actualOrigin = new URL(guest.getURL()).origin;
    } catch {
      return;
    }
    if (
      actualOrigin !== candidate?.origin ||
      (!actualOrigin.startsWith("https://") && !/^http:\/\/localhost(?::\d+)?$/i.test(actualOrigin)) ||
      typeof candidate.username !== "string" ||
      typeof candidate.password !== "string" ||
      !candidate.username ||
      !candidate.password ||
      !mainWindow ||
      mainWindow.isDestroyed()
    ) return;
    writeLog("info", "password.save-prompted", { origin: safeOrigin(actualOrigin) });
    mainWindow.webContents.send("password:save-prompt", {
      webContentsId: guest.id,
      origin: actualOrigin,
      username: candidate.username.slice(0, 300),
      password: candidate.password.slice(0, 2000)
    });
  });

  ipcMain.handle("password:list", (event, { webContentsId, origin } = {}) => {
    requireMainWindow(event);
    if (webContentsId !== undefined) getTrustedGuest(webContentsId, origin);
    const credentials = passwordVault.list(origin);
    writeLog("debug", "password.list.completed", {
      origin: origin ? safeOrigin(origin) : undefined,
      count: credentials.length
    });
    return credentials;
  });

  ipcMain.handle("password:save", (event, candidate) => {
    requireMainWindow(event);
    getTrustedGuest(candidate?.webContentsId, candidate?.origin);
    const credential = passwordVault.save(candidate);
    writeLog("info", "password.saved", {
      origin: safeOrigin(credential.origin),
      credentialId: credential.id
    });
    return credential;
  });

  ipcMain.handle("password:retrieve", (event, request) => {
    requireMainWindow(event);
    getTrustedGuest(request?.webContentsId, request?.origin);
    const credential = passwordVault.get(request);
    if (!credential) throw new Error("The selected saved password no longer exists.");
    writeLog("info", "password.retrieved-after-confirmation", {
      origin: safeOrigin(credential.origin),
      credentialId: credential.id
    });
    return { username: credential.username, password: credential.password };
  });

  ipcMain.handle("password:remove", (event, id) => {
    requireMainWindow(event);
    if (typeof id !== "string") throw new TypeError("A saved-password identifier is required.");
    const removed = passwordVault.remove(id);
    writeLog("info", "password.removed", { credentialId: id, removed });
    return removed;
  });

  ipcMain.handle("settings:save-theme", (event, value) => {
    requireMainWindow(event);
    const theme = validateTheme(value);
    const store = readStore();
    store.theme = theme;
    writeStore(store);
    writeLog("info", "theme.saved", {});
    return theme;
  });

  ipcMain.handle("settings:load", (event) => {
    requireMainWindow(event);
    const store = readStore();
    return { theme: store.theme, adBlocking: store.adBlocking };
  });

  ipcMain.handle("settings:set-adblocking", (event, enabled) => {
    requireMainWindow(event);
    if (typeof enabled !== "boolean") throw new TypeError("Ad blocking state must be boolean.");
    adBlockingEnabled = enabled;
    const store = readStore();
    store.adBlocking = enabled;
    writeStore(store);
    writeLog("info", "privacy.ad-blocking-updated", { enabled, ruleCount: adFilter.ruleCount });
    return enabled;
  });

  ipcMain.handle("data:load", () => {
    writeLog("debug", "ipc.data-load.requested", {});
    try {
      return readStore();
    } catch (error) {
      writeLog("error", "ipc.data-load.failed", { error });
      throw error;
    }
  });

  ipcMain.handle("data:add-history", (_event, entry) => {
    writeLog("debug", "ipc.history-add.requested", { origin: safeOrigin(entry?.url) });
    const url = safeWebUrl(entry?.url);
    if (!url) {
      writeLog("warn", "ipc.history-add.rejected", { reason: "invalid-web-url" });
      return;
    }
    const store = readStore();
    store.history = [
      { url, title: String(entry.title || url).slice(0, 300), visitedAt: Date.now() },
      ...store.history.filter((item) => item.url !== url)
    ].slice(0, MAX_HISTORY_ITEMS);
    writeStore(store);
  });

  ipcMain.handle("data:add-bookmark", (_event, entry) => {
    writeLog("debug", "ipc.bookmark-add.requested", { origin: safeOrigin(entry?.url) });
    const url = safeWebUrl(entry?.url);
    if (!url) {
      writeLog("warn", "ipc.bookmark-add.rejected", { reason: "invalid-web-url" });
      return;
    }
    const store = readStore();
    if (store.bookmarks.some((item) => item.url === url)) return;
    store.bookmarks = [
      ...store.bookmarks,
      { url, title: String(entry.title || url).slice(0, 300) }
    ].slice(-MAX_BOOKMARKS);
    writeStore(store);
  });

  ipcMain.handle("data:remove-bookmark", (_event, value) => {
    writeLog("debug", "ipc.bookmark-remove.requested", { origin: safeOrigin(value) });
    const url = safeWebUrl(value);
    if (!url) {
      writeLog("warn", "ipc.bookmark-remove.rejected", { reason: "invalid-web-url" });
      return;
    }
    const store = readStore();
    store.bookmarks = store.bookmarks.filter((item) => item.url !== url);
    writeStore(store);
  });

  ipcMain.handle("data:clear", async () => {
    writeLog("info", "privacy.clear-data.started", {});
    const store = readStore();
    store.history = [];
    writeStore(store);
    await browserSession.clearStorageData();
    await browserSession.clearCache();
    writeLog("info", "privacy.clear-data.completed", {});
  });
}

function createWindow() {
  writeLog("info", "window.create.started", {});
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#101418",
    title: "999",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });
  mainWindow = window;
  mainWebContentsId = window.webContents.id;

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (params.partition !== BROWSER_PARTITION) {
      writeLog("warn", "webview.attach.rejected", { reason: "unexpected-partition" });
      event.preventDefault();
      return;
    }
    writeLog("debug", "webview.attach.accepted", { partition: params.partition });
    webPreferences.preload = path.join(__dirname, "guest-preload.js");
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });

  window.webContents.on("did-attach-webview", (_event, guest) => {
    writeLog("info", "webview.attached", { webContentsId: guest.id });
    guestContents.set(guest.id, guest);
    guest.once("destroyed", () => guestContents.delete(guest.id));
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    let initialBlankNavigation = true;
    const allowWebNavigation = (event, destination) => {
      if (initialBlankNavigation && destination === "about:blank") {
        initialBlankNavigation = false;
        writeLog("debug", "webview.initial-blank-navigation", {
          webContentsId: guest.id
        });
        return;
      }
      if (!safeWebUrl(destination)) {
        writeLog("warn", "webview.navigation.rejected", {
          destination: safeOrigin(destination)
        });
        event.preventDefault();
      }
    };
    guest.on("will-navigate", allowWebNavigation);
    guest.on("will-redirect", allowWebNavigation);
    guest.on("render-process-gone", (_event, details) => {
      writeLog("fatal", "webview.renderer-process-gone", {
        webContentsId: guest.id,
        reason: details.reason,
        exitCode: details.exitCode
      });
    });
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeLog("error", "window.load-failed", {
      errorCode,
      errorDescription,
      origin: safeOrigin(validatedURL),
      isMainFrame
    });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      writeLog("warn", "window.console-message", {
        level,
        line,
        sourceId,
        message
      });
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    writeLog("fatal", "window.renderer-process-gone", {
      reason: details.reason,
      exitCode: details.exitCode
    });
  });
  window.on("closed", () => writeLog("info", "window.closed", {}));
  window.loadFile(path.join(__dirname, "index.html")).catch((error) => {
    writeLog("fatal", "window.load-file.failed", { error });
  });
}

process.on("uncaughtException", (error) => {
  writeLog("fatal", "process.uncaught-exception", { error });
});
process.on("unhandledRejection", (reason) => {
  writeLog("fatal", "process.unhandled-rejection", { reason });
});
app.on("child-process-gone", (_event, details) => {
  writeLog("fatal", "app.child-process-gone", {
    type: details.type,
    serviceName: details.serviceName,
    reason: details.reason,
    exitCode: details.exitCode
  });
});

app.whenReady().then(() => {
  storePath = path.join(app.getPath("userData"), "browser-data.json");
  configureLogger(path.join(app.getPath("userData"), "logs"));
  passwordVault = createPasswordVault(
    path.join(app.getPath("userData"), "password-vault.json"),
    safeStorage
  );
  adFilter = createFilterEngine(
    fs.readFileSync(path.join(__dirname, "filters", "ads.txt"), "utf8").split(/\r?\n/)
  );
  writeLog("info", "privacy.ad-filter-loaded", { ruleCount: adFilter.ruleCount });
  writeLog("info", "app.ready", {
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    architecture: process.arch
  });
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  configureBrowserSession(browserSession);
  registerDataHandlers(browserSession);
  createWindow();

  app.on("activate", () => {
    writeLog("info", "app.activate", {});
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  writeLog("fatal", "app.ready.failed", { error });
  app.quit();
});

app.on("window-all-closed", () => {
  writeLog("info", "window.all-closed", { platform: process.platform });
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => writeLog("info", "app.before-quit", {}));
