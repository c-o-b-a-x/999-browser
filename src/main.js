const { app, BrowserWindow, dialog, ipcMain, session, shell, safeStorage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isTrackerUrl } = require("./privacy");
const { configureLogger, getLogDirectory, safeOrigin, writeLog } = require("./logger");
const { createFilterEngine } = require("./adblock");
const { createPasswordVault } = require("./password-vault");
const { DEFAULT_THEME, mergeTheme, validateTheme } = require("./theme");
const {
  DEFAULT_QOL_SETTINGS,
  getAssetFileName,
  validateImage,
  validateQolSettings
} = require("./qol-settings");

const BROWSER_PARTITION = "persist:quiet-browser";
const MAX_HISTORY_ITEMS = 1000;
const MAX_BOOKMARKS = 500;
let storePath;
let mainWebContentsId = null;
let mainWindow = null;
let passwordVault;
let adFilter;
let adBlockingEnabled = true;
let qolSettings = { ...DEFAULT_QOL_SETTINGS };
let appearanceAssets = { cursorDataUrl: null, wallpaperDataUrl: null };
let appearanceAssetDirectory;
const guestContents = new Map();
const guestAppearanceKeys = new Map();
const guestAppearanceTasks = new Map();

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
      qol: validateQolSettings(value.qol),
      adBlocking: value.adBlocking !== false
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      writeLog("error", "data.read.failed", { error });
      throw error;
    }
    writeLog("debug", "data.read.first-run", {});
    return {
      history: [],
      bookmarks: [],
      theme: DEFAULT_THEME,
      qol: { ...DEFAULT_QOL_SETTINGS },
      adBlocking: true
    };
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

function readAppearanceAsset(assetId, kind) {
  if (!assetId) return null;
  const fileName = getAssetFileName(assetId, kind);
  const filePath = path.join(appearanceAssetDirectory, fileName);
  const buffer = fs.readFileSync(filePath);
  const image = validateImage(buffer, path.extname(fileName), kind);
  return `data:${image.type};base64,${buffer.toString("base64")}`;
}

function currentAppearanceCss() {
  const rules = [];
  if (qolSettings.forceDarkMode) {
    rules.push(`
      html {
        color-scheme: dark !important;
        filter: invert(1) hue-rotate(180deg) contrast(.92) !important;
        background: #111 !important;
      }
      img, video, picture, canvas, svg, iframe {
        filter: invert(1) hue-rotate(180deg) !important;
      }
    `);
  }
  if (appearanceAssets.cursorDataUrl) {
    const cursor = appearanceAssets.cursorDataUrl.replace(/["'()\\\s]/g, "");
    rules.push(`
      *, *::before, *::after {
        cursor: url("${cursor}") 0 0, auto !important;
      }
      a, button, [role="button"], input[type="button"], input[type="submit"], label {
        cursor: url("${cursor}") 0 0, pointer !important;
      }
    `);
  }
  return rules.join("\n");
}

function applyGuestAppearance(guest) {
  if (!guest || guest.isDestroyed()) return Promise.resolve();
  const previous = guestAppearanceTasks.get(guest.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    if (guest.isDestroyed()) return;
    const previousKeys = guestAppearanceKeys.get(guest.id) || [];
    for (const key of previousKeys) {
      try {
        await guest.removeInsertedCSS(key);
      } catch (error) {
        writeLog("warn", "appearance.guest-css-remove-failed", {
          webContentsId: guest.id,
          error
        });
      }
    }
    guestAppearanceKeys.delete(guest.id);
    const css = currentAppearanceCss();
    if (!css || guest.isDestroyed()) return;
    try {
      const key = await guest.insertCSS(css, { cssOrigin: "user" });
      guestAppearanceKeys.set(guest.id, [key]);
    } catch (error) {
      writeLog("error", "appearance.guest-css-insert-failed", {
        webContentsId: guest.id,
        error
      });
    }
  }).finally(() => {
    if (guestAppearanceTasks.get(guest.id) === task) {
      guestAppearanceTasks.delete(guest.id);
    }
  });
  guestAppearanceTasks.set(guest.id, task);
  return task;
}

async function updateAllGuestAppearance() {
  await Promise.all([...guestContents.values()].map(applyGuestAppearance));
}

function updateAppearanceAssets(settings) {
  appearanceAssets = {
    cursorDataUrl: readAppearanceAsset(settings.cursorAsset, "cursor"),
    wallpaperDataUrl: readAppearanceAsset(settings.wallpaperAsset, "wallpaper")
  };
}

async function setQolSettings(settings) {
  const validated = validateQolSettings(settings);
  const nextAssets = {
    cursorDataUrl: readAppearanceAsset(validated.cursorAsset, "cursor"),
    wallpaperDataUrl: readAppearanceAsset(validated.wallpaperAsset, "wallpaper")
  };
  const store = readStore();
  store.qol = validated;
  writeStore(store);
  qolSettings = validated;
  appearanceAssets = nextAssets;
  await updateAllGuestAppearance();
  return {
    settings: qolSettings,
    assets: appearanceAssets
  };
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

  ipcMain.handle("password:manager-status", (event) => {
    requireMainWindow(event);
    return passwordVault.status();
  });

  ipcMain.handle("password:manager-setup", async (event, credentials) => {
    requireMainWindow(event);
    const result = await passwordVault.setup(credentials || {});
    writeLog("info", "password.manager.setup", {
      credentialCount: result.credentialCount
    });
    return result;
  });

  ipcMain.handle("password:manager-unlock", async (event, password) => {
    requireMainWindow(event);
    await passwordVault.unlock(password);
    writeLog("info", "password.manager.unlocked", {});
    return true;
  });

  ipcMain.handle("password:manager-recover", async (event, recovery) => {
    requireMainWindow(event);
    await passwordVault.recover(recovery || {});
    writeLog("warn", "password.manager.recovered", {});
    return true;
  });

  ipcMain.handle("password:manager-lock", (event) => {
    requireMainWindow(event);
    passwordVault.lockManager();
    return true;
  });

  ipcMain.handle("password:manager-list", (event) => {
    requireMainWindow(event);
    return passwordVault.listForManager();
  });

  ipcMain.handle("password:manager-reveal", (event, id) => {
    requireMainWindow(event);
    if (typeof id !== "string") {
      throw new TypeError("A saved-password identifier is required.");
    }
    const credential = passwordVault.revealForManager(id);
    if (!credential) throw new Error("The selected saved password no longer exists.");
    writeLog("info", "password.revealed-in-manager", {
      origin: safeOrigin(credential.origin)
    });
    return credential;
  });

  ipcMain.handle("password:list", (event, { webContentsId, origin } = {}) => {
    requireMainWindow(event);
    if (!Number.isInteger(webContentsId) || typeof origin !== "string") {
      throw new Error("Password account listings are only available to a browser tab.");
    }
    getTrustedGuest(webContentsId, origin);
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
    const removed = passwordVault.removeForManager(id);
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
    qolSettings = store.qol;
    updateAppearanceAssets(qolSettings);
    return {
      theme: store.theme,
      adBlocking: store.adBlocking,
      qol: qolSettings,
      assets: appearanceAssets
    };
  });

  ipcMain.handle("settings:save-qol", async (event, value) => {
    requireMainWindow(event);
    const updated = await setQolSettings(value);
    writeLog("info", "settings.qol-saved", {
      forceDarkMode: updated.settings.forceDarkMode,
      hasCursor: Boolean(updated.settings.cursorAsset),
      hasWallpaper: Boolean(updated.settings.wallpaperAsset),
      typingSounds: updated.settings.typingSounds,
      clickSounds: updated.settings.clickSounds
    });
    return updated;
  });

  ipcMain.handle("settings:import-appearance-asset", async (event, kind) => {
    requireMainWindow(event);
    if (kind !== "cursor" && kind !== "wallpaper") {
      throw new TypeError("Choose either a cursor or wallpaper image.");
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("The browser window is no longer available.");
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === "cursor" ? "Choose a cursor image" : "Choose a wallpaper image",
      properties: ["openFile"],
      filters: [{
        name: kind === "cursor" ? "PNG cursor images" : "Wallpaper images",
        extensions: kind === "cursor" ? ["png"] : ["png", "jpg", "jpeg"]
      }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const selectedPath = result.filePaths[0];
    const extension = path.extname(selectedPath).toLowerCase();
    const buffer = fs.readFileSync(selectedPath);
    const image = validateImage(buffer, extension, kind);
    const fileName = `${kind}-${crypto.randomUUID()}${extension}`;
    const destination = path.join(appearanceAssetDirectory, fileName);
    fs.mkdirSync(appearanceAssetDirectory, { recursive: true });
    fs.writeFileSync(destination, buffer, { flag: "wx", mode: 0o600 });
    let previousAsset;
    try {
      const store = readStore();
      previousAsset = store.qol[kind === "cursor" ? "cursorAsset" : "wallpaperAsset"];
      store.qol = validateQolSettings({
        ...store.qol,
        [kind === "cursor" ? "cursorAsset" : "wallpaperAsset"]: fileName
      });
      writeStore(store);
      qolSettings = store.qol;
      await updateAppearanceAssets(qolSettings);
      await updateAllGuestAppearance();
    } catch (error) {
      try {
        fs.unlinkSync(destination);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          writeLog("error", "appearance.asset-cleanup-failed", {
            kind,
            error: cleanupError
          });
        }
      }
      throw error;
    }
    if (previousAsset) {
      try {
        fs.unlinkSync(path.join(appearanceAssetDirectory, getAssetFileName(previousAsset, kind)));
      } catch (error) {
        if (error.code !== "ENOENT") {
          writeLog("error", "appearance.asset-replace-cleanup-failed", { kind, error });
        }
      }
    }
    writeLog("info", "appearance.asset-imported", { kind, imageType: image.type });
    return { settings: qolSettings, assets: appearanceAssets };
  });

  ipcMain.handle("settings:remove-appearance-asset", async (event, kind) => {
    requireMainWindow(event);
    if (kind !== "cursor" && kind !== "wallpaper") {
      throw new TypeError("Choose either a cursor or wallpaper image.");
    }
    const store = readStore();
    const settingKey = kind === "cursor" ? "cursorAsset" : "wallpaperAsset";
    const previousAsset = store.qol[settingKey];
    store.qol = validateQolSettings({ ...store.qol, [settingKey]: null });
    writeStore(store);
    qolSettings = store.qol;
    await updateAppearanceAssets(qolSettings);
    await updateAllGuestAppearance();
    if (previousAsset) {
      try {
        fs.unlinkSync(path.join(appearanceAssetDirectory, getAssetFileName(previousAsset, kind)));
      } catch (error) {
        if (error.code !== "ENOENT") {
          writeLog("error", "appearance.asset-remove-failed", { kind, error });
          throw error;
        }
      }
    }
    writeLog("info", "appearance.asset-removed", { kind });
    return { settings: qolSettings, assets: appearanceAssets };
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
    icon: path.join(__dirname, "..", "peepers-icon.png"),
    title: "no peepers",
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
    guest.once("destroyed", () => {
      guestContents.delete(guest.id);
      guestAppearanceKeys.delete(guest.id);
      guestAppearanceTasks.delete(guest.id);
    });
    guest.on("dom-ready", () => {
      applyGuestAppearance(guest);
    });
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
  window.on("closed", () => {
    passwordVault.lockManager();
    writeLog("info", "window.closed", {});
  });
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

app.whenReady().then(async () => {
  storePath = path.join(app.getPath("userData"), "browser-data.json");
  configureLogger(path.join(app.getPath("userData"), "logs"));
  appearanceAssetDirectory = path.join(app.getPath("userData"), "appearance-assets");
  qolSettings = readStore().qol;
  await updateAppearanceAssets(qolSettings);
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
app.on("before-quit", () => {
  passwordVault?.lockManager();
  writeLog("info", "app.before-quit", {});
});
