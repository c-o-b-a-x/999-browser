const BROWSER_PARTITION = "persist:quiet-browser";
const { isCanceledNavigation } = window.QuietNavigationErrors;
const { isTypingSoundTarget } = window.QuietQolSettings;
const tabsElement = document.querySelector("#tabs");
const viewContainer = document.querySelector("#view-container");
const addressInput = document.querySelector("#address");
const backButton = document.querySelector("#back");
const forwardButton = document.querySelector("#forward");
const tabs = [];
let activeTabId = null;
let nextTabId = 1;
let currentTheme = window.QuietTheme.DEFAULT_THEME;
let currentQolSettings = {
  forceDarkMode: false,
  cursorAsset: null,
  wallpaperAsset: null,
  typingSounds: true,
  clickSounds: true,
  showBranding: true,
  showHeadline: true,
  showIntro: true,
  showSearchBar: true,
  showPrivacyNote: true
};
let interfaceAudioContext = null;
let themeSaved = false;
let pendingSaveCandidate = null;
let passwordManagerUnlocked = false;
const savePromptQueue = [];
let pendingAutofill = null;

function log(level, event, details = {}) {
  window.quietBrowser.log(level, event, details);
}

function showToast(message, type = "info", duration = 2800) {
  const region = document.querySelector("#toast-region");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.textContent = message;
  region.append(toast);
  setTimeout(() => toast.remove(), duration);
}

function playInterfaceSound(kind) {
  if (!currentQolSettings[kind === "typing" ? "typingSounds" : "clickSounds"]) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    interfaceAudioContext ||= new AudioContextClass();
    if (interfaceAudioContext.state === "suspended") {
      interfaceAudioContext.resume().catch((error) => {
        log("warn", "sound.resume-failed", { error });
      });
    }
    const oscillator = interfaceAudioContext.createOscillator();
    const gain = interfaceAudioContext.createGain();
    const now = interfaceAudioContext.currentTime;
    oscillator.type = kind === "typing" ? "triangle" : "sine";
    oscillator.frequency.value = kind === "typing" ? 720 : 480;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === "typing" ? 0.025 : 0.035, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === "typing" ? 0.035 : 0.055));
    oscillator.connect(gain);
    gain.connect(interfaceAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + (kind === "typing" ? 0.04 : 0.06));
  } catch (error) {
    log("warn", "sound.play-failed", { kind, error });
  }
}

function applyQolSettings(settings, assets, populateForm = true) {
  currentQolSettings = settings;
  const root = document.documentElement;
  if (assets.cursorDataUrl) {
    root.style.setProperty("--custom-cursor", `url("${assets.cursorDataUrl}") 0 0, auto`);
    root.style.setProperty("--custom-pointer-cursor", `url("${assets.cursorDataUrl}") 0 0, pointer`);
  } else {
    root.style.removeProperty("--custom-cursor");
    root.style.removeProperty("--custom-pointer-cursor");
  }
  if (assets.wallpaperDataUrl) {
    root.style.setProperty("--wallpaper-image", `url("${assets.wallpaperDataUrl}")`);
  } else {
    root.style.removeProperty("--wallpaper-image");
  }
  if (populateForm) {
    document.querySelector("#force-dark-mode").checked = settings.forceDarkMode;
    document.querySelector("#typing-sounds").checked = settings.typingSounds;
    document.querySelector("#click-sounds").checked = settings.clickSounds;
    for (const key of [
      "showBranding",
      "showHeadline",
      "showIntro",
      "showSearchBar",
      "showPrivacyNote"
    ]) {
      document.querySelector(`#${key}`).checked = settings[key];
    }
  }
  applyStartPageOptions(document);
  for (const tab of tabs) applyStartPageOptions(tab.home);
  document.querySelector("#cursor-asset-name").textContent =
    settings.cursorAsset ? "Custom cursor active" : "Default cursor";
  document.querySelector("#remove-cursor").disabled = !settings.cursorAsset;
  document.querySelector("#wallpaper-asset-name").textContent =
    settings.wallpaperAsset ? "Custom wallpaper active" : "Default background";
  document.querySelector("#remove-wallpaper").disabled = !settings.wallpaperAsset;
}

function readQolFormSettings() {
  return {
    ...currentQolSettings,
    forceDarkMode: document.querySelector("#force-dark-mode").checked,
    typingSounds: document.querySelector("#typing-sounds").checked,
    clickSounds: document.querySelector("#click-sounds").checked,
    showBranding: document.querySelector("#showBranding").checked,
    showHeadline: document.querySelector("#showHeadline").checked,
    showIntro: document.querySelector("#showIntro").checked,
    showSearchBar: document.querySelector("#showSearchBar").checked,
    showPrivacyNote: document.querySelector("#showPrivacyNote").checked
  };
}

function applyStartPageOptions(container) {
  for (const [feature, setting] of Object.entries({
    branding: "showBranding",
    headline: "showHeadline",
    intro: "showIntro",
    search: "showSearchBar",
    privacy: "showPrivacyNote"
  })) {
    const element = container.querySelector(`[data-start-feature="${feature}"]`);
    if (element) element.hidden = !currentQolSettings[setting];
  }
}

function showPageProgress(visible) {
  document.querySelector("#page-progress").classList.toggle("hidden", !visible);
  document.querySelector("#view-container").setAttribute("aria-busy", String(visible));
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.style.setProperty("--background", theme.background);
  root.style.setProperty("--surface", theme.surface);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--text", theme.text);
  root.style.setProperty("--muted-text", theme.muted);
  root.style.setProperty("--font-family", `"${theme.fontFamily}"`);
  root.style.setProperty("--color-scheme", theme.colorScheme);
  root.style.setProperty("--font-size", `${theme.fontSize}px`);
  root.style.setProperty("--corner-radius", `${theme.cornerRadius}px`);
}

function populateThemeForm() {
  const form = document.querySelector("#theme-form");
  for (const [key, value] of Object.entries(currentTheme)) {
    form.elements.namedItem(key).value = value;
  }
  document.querySelector("#theme-font-size").value = `${currentTheme.fontSize} px`;
  document.querySelector("#theme-corner-radius").value = `${currentTheme.cornerRadius} px`;
}

function showSettingsSection(sectionName) {
  for (const button of document.querySelectorAll(".settings-menu-item")) {
    const selected = button.dataset.settingsSection === sectionName;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const panel of document.querySelectorAll(".settings-section")) {
    const selected = panel.dataset.settingsPanel === sectionName;
    panel.classList.toggle("active", selected);
    panel.hidden = !selected;
  }
  if (sectionName === "passwords") {
    initializePasswordManager().catch((error) => {
      setPasswordManagerView("unlock");
      document.querySelector("#password-manager-status").textContent = error.message;
      log("error", "password.manager-initialize-failed", { error });
    });
  } else {
    lockPasswordManagerView();
  }
}

function showNavigationError(message) {
  document.querySelector("#navigation-error-message").textContent = message;
  document.querySelector("#navigation-error").classList.remove("hidden");
  showToast(message, "error", 5000);
}

function clearNavigationError() {
  document.querySelector("#navigation-error").classList.add("hidden");
}

window.addEventListener("error", (event) => {
  log("fatal", "uncaught-error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error
  });
});
window.addEventListener("unhandledrejection", (event) => {
  log("fatal", "unhandled-rejection", { reason: event.reason });
});
log("info", "renderer.started", {
  userAgent: navigator.userAgent,
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight
});

function activeTab() {
  return tabs.find((tab) => tab.id === activeTabId);
}

function navigate(tab, value) {
  if (!tab) {
    log("error", "navigation.no-active-tab", {});
    return;
  }
  const url = window.QuietPrivacy.normalizeAddress(value);
  if (!url) {
    log("warn", "navigation.empty-input", { tabId: tab.id });
    return;
  }
  log("info", "navigation.requested", {
    tabId: tab.id,
    origin: url,
    webviewReady: tab.ready,
    queued: !tab.ready
  });
  clearNavigationError();
  tab.isHome = false;
  tab.lastRequestedUrl = url;
  if (tab.id === activeTabId) showPageProgress(true);
  tab.view.classList.remove("webview-hidden");
  tab.home.classList.add("hidden");
  if (!tab.ready) {
    tab.pendingUrl = url;
  } else {
    tab.view.loadURL(url).catch((error) => {
      if (isCanceledNavigation(undefined, undefined, error)) {
        log("info", "navigation.superseded", { tabId: tab.id, origin: url });
        return;
      }
      log("error", "navigation.loadURL-rejected", { tabId: tab.id, origin: url, error });
      showNavigationError(`Could not load page: ${error.message}`);
    });
  }
  addressInput.value = url;
}

function updateNavigation() {
  const tab = activeTab();
  if (!tab) return;
  backButton.disabled = !tab.ready || !tab.view.canGoBack();
  forwardButton.disabled = !tab.ready || !tab.view.canGoForward();
  addressInput.value = tab.isHome ? "" : tab.url;
  document.querySelector("#bookmark").disabled = tab.isHome || !tab.url;
}

function renderTabs() {
  tabsElement.replaceChildren();
  for (const tab of tabs) {
    const button = document.createElement("button");
    button.className = `tab${tab.id === activeTabId ? " active" : ""}`;
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === activeTabId));

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title || "New tab";
    button.append(label);
    button.addEventListener("click", () => activateTab(tab.id));

    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", `Close ${tab.title || "tab"}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });
    button.append(close);
    tabsElement.append(button);
  }
}

function activateTab(id) {
  log("debug", "tab.activate", { tabId: id });
  activeTabId = id;
  const tab = activeTab();
  showPageProgress(Boolean(
    tab &&
    !tab.isHome &&
    typeof tab.view.isLoading === "function" &&
    tab.view.isLoading()
  ));
  for (const tab of tabs) {
    tab.view.classList.toggle("webview-hidden", tab.id !== id || tab.isHome);
    tab.home.classList.toggle("hidden", tab.id !== id || !tab.isHome);
  }
  renderTabs();
  updateNavigation();
  offerAutofill(activeTab()).catch((error) => {
    log("error", "password.autofill-prompt-failed", { tabId: id, error });
  });
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) {
    log("warn", "tab.close.unknown", { tabId: id });
    return;
  }
  const [tab] = tabs.splice(index, 1);
  log("info", "tab.closed", { tabId: id, wasActive: activeTabId === id });
  tab.view.remove();
  tab.home.remove();
  if (!tabs.length) {
    createTab();
    return;
  }
  if (activeTabId === id) activateTab(tabs[Math.min(index, tabs.length - 1)].id);
  else renderTabs();
}

function createTab() {
  const id = nextTabId++;
  log("info", "tab.create", { tabId: id });
  const view = document.createElement("webview");
  view.setAttribute("partition", BROWSER_PARTITION);
  view.setAttribute("src", "about:blank");
  view.classList.add("webview-hidden");

  const home = document.createElement("div");
  home.className = "start-page";
  home.classList.add("hidden");
  home.append(document.querySelector("#start-page-template").content.cloneNode(true));
  applyStartPageOptions(home);
  home.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(tab, home.querySelector("input").value);
  });

  const tab = {
    id,
    title: "New tab",
    url: "",
    view,
    home,
    isHome: true,
    ready: false,
    pendingUrl: null,
    lastRequestedUrl: null,
    autofillOfferedFor: null
  };
  view.addEventListener("dom-ready", () => {
    tab.ready = true;
    log("info", "webview.dom-ready", { tabId: id, hasPendingNavigation: Boolean(tab.pendingUrl) });
    if (tab.pendingUrl) {
      const url = tab.pendingUrl;
      tab.pendingUrl = null;
      view.loadURL(url).catch((error) => {
        if (isCanceledNavigation(undefined, undefined, error)) {
          log("info", "navigation.queued-superseded", { tabId: id, origin: url });
          return;
        }
        log("error", "navigation.queued-load-rejected", { tabId: id, origin: url, error });
        showNavigationError(`Could not load page: ${error.message}`);
      });
    }
    if (tab.id === activeTabId) updateNavigation();
    offerAutofill(tab).catch((error) => {
      log("error", "password.autofill-prompt-failed", { tabId: id, error });
    });
  });
  view.addEventListener("page-title-updated", (event) => {
    if (tab.isHome && !tab.url && event.title === "about:blank") return;
    tab.title = event.title || tab.url || "New tab";
    log("debug", "webview.title-updated", { tabId: id });
    renderTabs();
  });
  view.addEventListener("did-navigate", (event) => {
    if (tab.isHome && !tab.url && event.url === "about:blank") {
      log("debug", "webview.initial-blank-navigation", { tabId: id });
      return;
    }
    tab.url = event.url;
    tab.isHome = false;
    tab.lastRequestedUrl = event.url;
    tab.autofillOfferedFor = null;
    log("info", "webview.navigated", { tabId: id, origin: event.url });
    if (tab.id === activeTabId) updateNavigation();
    if (/^https?:\/\//i.test(event.url)) {
      window.quietBrowser.addHistory({ url: event.url, title: tab.title }).catch(showError);
    }
  });
  view.addEventListener("did-navigate-in-page", (event) => {
    tab.url = event.url;
    log("debug", "webview.in-page-navigation", { tabId: id, origin: event.url, isMainFrame: event.isMainFrame });
    if (tab.id === activeTabId) updateNavigation();
  });
  view.addEventListener("did-fail-load", (event) => {
    const canceled = isCanceledNavigation(event.errorCode, event.errorDescription);
    log(canceled ? "debug" : "error", canceled ? "webview.load-canceled" : "webview.load-failed", {
      tabId: id,
      errorCode: event.errorCode,
      errorDescription: event.errorDescription,
      origin: event.validatedURL,
      isMainFrame: event.isMainFrame
    });
    if (event.isMainFrame && !canceled) {
      showNavigationError(
        `Could not load page (${event.errorCode}): ${event.errorDescription}`
      );
      if (tab.id === activeTabId) showPageProgress(false);
    }
    if (tab.id === activeTabId) updateNavigation();
  });
  view.addEventListener("did-start-loading", () => {
    if (tab.id === activeTabId && !tab.isHome) showPageProgress(true);
  });
  view.addEventListener("did-stop-loading", () => {
    log("debug", "webview.loading-stopped", { tabId: id, origin: tab.url });
    if (tab.id === activeTabId) showPageProgress(false);
    if (tab.id === activeTabId) updateNavigation();
  });
  view.addEventListener("console-message", (event) => {
    if (event.level >= 2) {
      log("warn", "webview.console-message", {
        tabId: id,
        level: event.level,
        line: event.line,
        sourceId: event.sourceId,
        message: event.message
      });
    }
  });
  view.addEventListener("render-process-gone", (event) => {
    log("fatal", "webview.render-process-gone", {
      tabId: id,
      reason: event.reason,
      exitCode: event.exitCode
    });
  });

  tabs.push(tab);
  viewContainer.append(view, home);
  activateTab(id);
}

function renderBookmarksBar(bookmarks) {
  const bar = document.querySelector("#bookmarks-bar");
  bar.replaceChildren();
  if (!bookmarks.length) {
    const empty = document.createElement("span");
    empty.className = "bookmarks-empty";
    empty.textContent = "Bookmarks you save will appear here";
    bar.append(empty);
    return;
  }
  for (const bookmark of bookmarks) {
    const button = document.createElement("button");
    button.className = "bookmark-bar-item";
    button.type = "button";
    button.textContent = bookmark.title || bookmark.url;
    button.title = bookmark.url;
    button.addEventListener("click", () => navigate(activeTab(), bookmark.url));
    bar.append(button);
  }
  const manage = document.createElement("button");
  manage.className = "bookmark-bar-item";
  manage.type = "button";
  manage.textContent = "All bookmarks…";
  manage.addEventListener("click", () => {
    renderLibrary()
      .then(() => document.querySelector("#library-dialog").showModal())
      .catch(showError);
  });
  bar.append(manage);
}

async function initializeSettings() {
  try {
    const settings = await window.quietBrowser.loadSettings();
    currentTheme = window.QuietTheme.mergeTheme(settings.theme);
    applyTheme(currentTheme);
    applyQolSettings(settings.qol, settings.assets);
    const toggle = document.querySelector("#adblock-toggle");
    toggle.setAttribute("aria-pressed", String(settings.adBlocking));
    toggle.textContent = settings.adBlocking ? "On" : "Off";
    await renderLibrary();
  } catch (error) {
    log("error", "settings.initialize-failed", { error });
    showError(error, "Could not load browser settings");
  }
}

async function offerAutofill(tab) {
  if (!tab || tab.id !== activeTabId || !tab.ready || tab.isHome) return;
  let origin;
  try {
    origin = new URL(tab.view.getURL()).origin;
  } catch {
    return;
  }
  const secureOrigin =
    origin.startsWith("https://") || /^http:\/\/localhost(?::\d+)?$/i.test(origin);
  if (!secureOrigin || tab.autofillOfferedFor === origin) return;
  tab.autofillOfferedFor = origin;
  const credentials = await window.quietBrowser.listPasswords({
    webContentsId: tab.view.getWebContentsId(),
    origin
  });
  if (!credentials.length) return;
  pendingAutofill = { tab, origin, credentials };
  const select = document.querySelector("#autofill-account");
  select.replaceChildren();
  for (const credential of credentials) {
    const option = document.createElement("option");
    option.value = credential.id;
    option.textContent = credential.username;
    select.append(option);
  }
  document.querySelector("#autofill-origin").textContent = origin;
  if (!document.querySelector("#autofill-dialog").open) {
    document.querySelector("#autofill-dialog").showModal();
  }
}

function showNextSavePrompt() {
  if (
    pendingSaveCandidate ||
    !savePromptQueue.length ||
    document.querySelector("dialog[open]")
  ) return;
  pendingSaveCandidate = savePromptQueue.shift();
  document.querySelector("#password-save-origin").textContent =
    pendingSaveCandidate.origin;
  document.querySelector("#password-save-username").value =
    pendingSaveCandidate.username;
  document.querySelector("#password-save-status").textContent = "";
  document.querySelector("#password-prompt-dialog").showModal();
}

window.quietBrowser.onPasswordSavePrompt((candidate) => {
  log("info", "password.save-prompt-received", {
    origin: candidate.origin,
    webContentsId: candidate.webContentsId
  });
  savePromptQueue.push(candidate);
  showNextSavePrompt();
});

async function renderPasswordManager() {
  const list = document.querySelector("#password-list");
  list.replaceChildren();
  const credentials = await window.quietBrowser.listManagedPasswords();
  if (!passwordManagerUnlocked) return;
  if (!credentials.length) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "No saved passwords.";
    list.append(empty);
    return;
  }
  for (const credential of credentials) {
    const row = document.createElement("li");
    const detail = document.createElement("span");
    detail.className = "credential-detail";
    detail.textContent = `${credential.origin} — ${credential.username}`;
    const password = document.createElement("input");
    password.className = "credential-secret dialog-input";
    password.type = "password";
    password.readOnly = true;
    password.autocomplete = "off";
    password.setAttribute("aria-label", `Saved password for ${credential.username} at ${credential.origin}`);
    const visibility = document.createElement("button");
    visibility.className = "secondary-button";
    visibility.type = "button";
    visibility.textContent = "Show";
    visibility.setAttribute("aria-label", `Show password for ${credential.username} at ${credential.origin}`);
    visibility.addEventListener("click", async () => {
      if (password.type === "text") {
        password.type = "password";
        password.value = "";
        visibility.textContent = "Show";
        visibility.setAttribute("aria-label", `Show password for ${credential.username} at ${credential.origin}`);
        return;
      }
      try {
        const revealed = await window.quietBrowser.revealManagedPassword(credential.id);
        if (!passwordManagerUnlocked) return;
        password.value = revealed.password;
        password.type = "text";
        visibility.textContent = "Hide";
        visibility.setAttribute("aria-label", `Hide password for ${credential.username} at ${credential.origin}`);
      } catch (error) {
        document.querySelector("#password-manager-status").textContent = error.message;
        log("error", "password.reveal-failed", { error });
      }
    });
    const remove = document.createElement("button");
    remove.className = "remove-bookmark";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete saved password for ${credential.origin}`);
    remove.addEventListener("click", async () => {
      try {
        await window.quietBrowser.removePassword(credential.id);
        await renderPasswordManager();
        showToast("Saved password removed.", "success");
      } catch (error) {
        document.querySelector("#password-manager-status").textContent = error.message;
        showToast(`Could not remove saved password: ${error.message}`, "error", 5000);
        log("error", "password.remove-failed", { error });
      }
    });
    row.className = "password-row";
    row.append(detail, password, visibility, remove);
    list.append(row);
  }
}

function setPasswordManagerView(view) {
  document.querySelector("#password-manager-setup").hidden = view !== "setup";
  document.querySelector("#password-manager-unlock").hidden = view !== "unlock";
  document.querySelector("#password-manager-recovery").hidden = view !== "recovery";
  document.querySelector("#password-manager-content").hidden = view !== "content";
}

async function initializePasswordManager() {
  passwordManagerUnlocked = false;
  document.querySelector("#password-list").replaceChildren();
  document.querySelector("#password-manager-status").textContent = "";
  setPasswordManagerView("unlock");
  const status = await window.quietBrowser.getPasswordManagerStatus();
  setPasswordManagerView(status.configured ? "unlock" : "setup");
}

async function showUnlockedPasswordManager() {
  if (
    document.querySelector('[data-settings-panel="passwords"]').hidden ||
    !document.querySelector("#settings-dialog").open
  ) {
    await window.quietBrowser.lockPasswordManager();
    return false;
  }
  passwordManagerUnlocked = true;
  setPasswordManagerView("content");
  try {
    await renderPasswordManager();
  } catch (error) {
    passwordManagerUnlocked = false;
    setPasswordManagerView("unlock");
    await window.quietBrowser.lockPasswordManager();
    throw error;
  }
  return true;
}

function lockPasswordManagerView() {
  passwordManagerUnlocked = false;
  const list = document.querySelector("#password-list");
  if (list) list.replaceChildren();
  for (const form of document.querySelectorAll(
    "#password-manager-setup-form, #password-manager-unlock-form, #password-manager-recovery-form"
  )) {
    form.reset();
  }
  const content = document.querySelector("#password-manager-content");
  if (content) content.hidden = true;
  const setup = document.querySelector("#password-manager-setup");
  if (setup) setup.hidden = true;
  const recovery = document.querySelector("#password-manager-recovery");
  if (recovery) recovery.hidden = true;
  const unlock = document.querySelector("#password-manager-unlock");
  if (unlock) unlock.hidden = true;
  window.quietBrowser.lockPasswordManager().catch((error) => {
    log("error", "password.manager-lock-failed", { error });
  });
}

async function unlockPasswordManager(masterPassword) {
  await window.quietBrowser.unlockPasswordManager(masterPassword);
  await showUnlockedPasswordManager();
}

function showError(error, context = "Could not complete action") {
  log("error", "ui.operation-failed", { context, error });
  const status = document.querySelector("#privacy-status");
  status.textContent = `${context}: ${error.message}`;
  showToast(`${context}: ${error.message}`, "error", 5000);
}

async function renderLibrary() {
  log("debug", "library.render.started", {});
  const data = await window.quietBrowser.loadData();
  const bookmarkList = document.querySelector("#bookmark-list");
  const historyList = document.querySelector("#history-list");
  bookmarkList.replaceChildren();
  historyList.replaceChildren();
  appendLibraryItems(bookmarkList, data.bookmarks, true);
  appendLibraryItems(historyList, data.history, false);
  renderBookmarksBar(data.bookmarks);
  log("debug", "library.render.completed", {
    bookmarks: data.bookmarks.length,
    history: data.history.length
  });
}

function appendLibraryItems(list, items, removable) {
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "Nothing here yet.";
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("li");
    const link = document.createElement("button");
    link.className = "list-link";
    link.type = "button";
    link.textContent = item.title || item.url;
    link.title = item.url;
    link.addEventListener("click", () => {
      navigate(activeTab(), item.url);
      document.querySelector("#library-dialog").close();
    });
    row.append(link);
    if (removable) {
      const remove = document.createElement("button");
      remove.className = "remove-bookmark";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove bookmark ${item.title || item.url}`);
      remove.addEventListener("click", async () => {
        try {
          await window.quietBrowser.removeBookmark(item.url);
          await renderLibrary();
        } catch (error) {
          showError(error);
        }
      });
      row.append(remove);
    }
    list.append(row);
  }
}

document.querySelector("#address-form").addEventListener("submit", (event) => {
  event.preventDefault();
  log("debug", "address-form.submitted", {});
  navigate(activeTab(), addressInput.value);
});
document.querySelector("#new-tab").addEventListener("click", createTab);
backButton.addEventListener("click", () => {
  const tab = activeTab();
  if (tab?.ready && tab.view.canGoBack()) tab.view.goBack();
});
forwardButton.addEventListener("click", () => {
  const tab = activeTab();
  if (tab?.ready && tab.view.canGoForward()) tab.view.goForward();
});
document.querySelector("#reload").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab?.ready || tab.isHome) return;
  tab.view.reload();
});
document.querySelector("#retry-navigation").addEventListener("click", () => {
  const tab = activeTab();
  if (tab?.lastRequestedUrl) navigate(tab, tab.lastRequestedUrl);
});
document.querySelector("#dismiss-navigation-error").addEventListener("click", clearNavigationError);
document.querySelector("#bookmark").addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab?.url || tab.isHome) {
    log("warn", "bookmark.add.skipped", { reason: "no-page" });
    return;
  }
  try {
    log("info", "bookmark.add.started", { tabId: tab.id, origin: tab.url });
    await window.quietBrowser.addBookmark({ url: tab.url, title: tab.title });
    await renderLibrary();
    log("info", "bookmark.add.completed", { tabId: tab.id });
    showToast("Bookmark saved.", "success");
  } catch (error) {
    showError(error);
  }
});
document.querySelector("#library-button").addEventListener("click", async () => {
  try {
    await renderLibrary();
    document.querySelector("#library-dialog").showModal();
  } catch (error) {
    showError(error);
  }
});
document.querySelector("#settings-button").addEventListener("click", () => {
  themeSaved = false;
  populateThemeForm();
  showSettingsSection("general");
  document.querySelector("#settings-dialog").showModal();
});
document.querySelectorAll(".settings-menu-item").forEach((button) => {
  button.addEventListener("click", () => {
    showSettingsSection(button.dataset.settingsSection);
  });
});
document.querySelector("#settings-dialog").addEventListener("close", () => {
  if (!themeSaved) applyTheme(currentTheme);
  themeSaved = false;
  lockPasswordManagerView();
});
document.querySelectorAll(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
document.querySelector("#clear-data").addEventListener("click", async () => {
  const status = document.querySelector("#privacy-status");
  status.textContent = "";
  try {
    log("info", "privacy.clear-data.clicked", {});
    await window.quietBrowser.clearBrowsingData();
    await renderLibrary();
    status.textContent = "History, cookies, site storage, and cache cleared.";
  } catch (error) {
    log("error", "privacy.clear-data.failed", { error });
    status.textContent = `Could not clear browsing data: ${error.message}`;
  }
});
document.querySelector("#open-logs").addEventListener("click", async () => {
  const status = document.querySelector("#privacy-status");
  status.textContent = "";
  try {
    log("info", "logging.open-folder.clicked", {});
    await window.quietBrowser.openLogsFolder();
    status.textContent = "Opened the local diagnostic log folder.";
  } catch (error) {
    log("error", "logging.open-folder.failed", { error });
    status.textContent = `Could not open logs folder: ${error.message}`;
  }
});
document.querySelector("#adblock-toggle").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const enabled = button.getAttribute("aria-pressed") !== "true";
  try {
    const result = await window.quietBrowser.setAdBlocking(enabled);
    button.setAttribute("aria-pressed", String(result));
    button.textContent = result ? "On" : "Off";
    showToast(`Ad blocking ${result ? "enabled" : "disabled"}.`, "success");
  } catch (error) {
    showError(error, "Could not change ad blocking");
  }
});

document.querySelector("#password-manager-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = {
    masterPassword: document.querySelector("#master-password-new").value,
    masterPasswordConfirmation: document.querySelector("#master-password-confirm").value,
    recoveryPin: document.querySelector("#recovery-pin-new").value,
    recoveryPinConfirmation: document.querySelector("#recovery-pin-confirm").value
  };
  const status = document.querySelector("#password-manager-status");
  status.textContent = "";
  try {
    const result = await window.quietBrowser.setupPasswordManager(fields);
    form.reset();
    const shown = await showUnlockedPasswordManager();
    if (!shown) return;
    status.textContent = result.credentialCount
      ? `Password manager ready. Migrated ${result.credentialCount} saved password(s).`
      : "Password manager ready.";
    log("info", "password.manager-setup-completed", {
      migratedCredentials: result.credentialCount
    });
  } catch (error) {
    form.reset();
    status.textContent = error.message;
    log("error", "password.manager-setup-failed", { error });
  }
});

document.querySelector("#password-manager-unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#master-password-unlock");
  const status = document.querySelector("#password-manager-status");
  status.textContent = "";
  try {
    await unlockPasswordManager(input.value);
    input.value = "";
    log("info", "password.manager-unlock-completed", {});
  } catch (error) {
    input.value = "";
    status.textContent = error.message;
    log("warn", "password.manager-unlock-failed", { error });
  }
});

document.querySelector("#password-manager-show-recovery").addEventListener("click", () => {
  document.querySelector("#password-manager-unlock-form").reset();
  document.querySelector("#password-manager-status").textContent = "";
  setPasswordManagerView("recovery");
});

document.querySelector("#password-manager-cancel-recovery").addEventListener("click", () => {
  document.querySelector("#password-manager-recovery-form").reset();
  document.querySelector("#password-manager-status").textContent = "";
  setPasswordManagerView("unlock");
});

document.querySelector("#password-manager-recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const fields = {
    recoveryPin: document.querySelector("#recovery-pin-unlock").value,
    masterPassword: document.querySelector("#master-password-reset").value,
    masterPasswordConfirmation: document.querySelector("#master-password-reset-confirm").value
  };
  const form = event.currentTarget;
  const status = document.querySelector("#password-manager-status");
  status.textContent = "";
  try {
    await window.quietBrowser.recoverPasswordManager(fields);
    form.reset();
    const shown = await showUnlockedPasswordManager();
    if (!shown) return;
    status.textContent = "Master password reset.";
    log("info", "password.manager-recovery-completed", {});
  } catch (error) {
    document.querySelector("#recovery-pin-unlock").value = "";
    document.querySelector("#master-password-reset").value = "";
    document.querySelector("#master-password-reset-confirm").value = "";
    status.textContent = error.message;
    log("warn", "password.manager-recovery-failed", { error });
  }
});

document.querySelector("#password-manager-lock").addEventListener("click", () => {
  lockPasswordManagerView();
  initializePasswordManager().catch((error) => {
    document.querySelector("#password-manager-status").textContent = error.message;
    log("error", "password.manager-lock-failed", { error });
  });
});

document.querySelector("#password-save-never").addEventListener("click", () => {
  document.querySelector("#password-prompt-dialog").close();
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("close", () => {
    if (dialog.id === "password-prompt-dialog") pendingSaveCandidate = null;
    setTimeout(showNextSavePrompt, 0);
  });
});
document.querySelector("#password-save-confirm").addEventListener("click", async () => {
  if (!pendingSaveCandidate) return;
  const status = document.querySelector("#password-save-status");
  const candidate = {
    ...pendingSaveCandidate,
    username: document.querySelector("#password-save-username").value
  };
  try {
    await window.quietBrowser.savePassword(candidate);
    pendingSaveCandidate = null;
    document.querySelector("#password-prompt-dialog").close();
    showToast("Password saved securely.", "success");
  } catch (error) {
    status.textContent = error.message;
    showToast(`Could not save password: ${error.message}`, "error", 5000);
    log("error", "password.save-failed", { origin: candidate.origin, error });
  }
});
document.querySelector("#autofill-confirm").addEventListener("click", async () => {
  const request = pendingAutofill;
  if (!request) return;
  const status = document.querySelector("#autofill-status");
  const credentialId = document.querySelector("#autofill-account").value;
  try {
    const credential = await window.quietBrowser.retrievePassword({
      webContentsId: request.tab.view.getWebContentsId(),
      origin: request.origin,
      id: credentialId
    });
    if (new URL(request.tab.view.getURL()).origin !== request.origin) {
      throw new Error("The active page changed before autofill could complete.");
    }
    const payload = JSON.stringify(credential).replace(/</g, "\\u003c");
    const fillScript = `(() => {
      const saved = ${payload};
      const fields = [...document.querySelectorAll("input:not([type='password'])")];
      const username = fields.find((field) =>
        /user|email|login|account/i.test(
          field.name + " " + field.id + " " + field.autocomplete + " " + field.type
        )
      ) || fields.find((field) => ["text", "email"].includes(field.type));
      const password = document.querySelector("input[type='password']");
      if (!password) return false;
      const setValue = (field, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(field),
          "value"
        )?.set;
        if (setter) setter.call(field, value);
        else field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (username) setValue(username, saved.username);
      setValue(password, saved.password);
      return true;
    })()`;
    const filled = await request.tab.view.executeJavaScript(fillScript, true);
    if (!filled) throw new Error("No password field was found on this page.");
    pendingAutofill = null;
    document.querySelector("#autofill-dialog").close();
    showToast("Saved credentials filled.", "success");
  } catch (error) {
    status.textContent = error.message;
    showToast(`Could not fill saved password: ${error.message}`, "error", 5000);
    log("error", "password.autofill-failed", { origin: request.origin, error });
  }
});
document.querySelector("#autofill-dialog").addEventListener("close", () => {
  pendingAutofill = null;
});

const themeForm = document.querySelector("#theme-form");
themeForm.addEventListener("input", () => {
  const theme = window.QuietTheme.mergeTheme({
    background: themeForm.elements.background.value,
    surface: themeForm.elements.surface.value,
    accent: themeForm.elements.accent.value,
    text: themeForm.elements.text.value,
    muted: themeForm.elements.muted.value,
    fontFamily: themeForm.elements.fontFamily.value,
    colorScheme: themeForm.elements.colorScheme.value,
    fontSize: Number(themeForm.elements.fontSize.value),
    cornerRadius: Number(themeForm.elements.cornerRadius.value)
  });
  applyTheme(theme);
  document.querySelector("#theme-font-size").value = `${theme.fontSize} px`;
  document.querySelector("#theme-corner-radius").value = `${theme.cornerRadius} px`;
});
themeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    currentTheme = window.QuietTheme.mergeTheme({
      background: themeForm.elements.background.value,
      surface: themeForm.elements.surface.value,
      accent: themeForm.elements.accent.value,
      text: themeForm.elements.text.value,
      muted: themeForm.elements.muted.value,
      fontFamily: themeForm.elements.fontFamily.value,
      colorScheme: themeForm.elements.colorScheme.value,
      fontSize: Number(themeForm.elements.fontSize.value),
      cornerRadius: Number(themeForm.elements.cornerRadius.value)
    });
    currentTheme = await window.quietBrowser.saveTheme(currentTheme);
    themeSaved = true;
    applyTheme(currentTheme);
    document.querySelector("#theme-status").textContent = "Theme saved.";
    showToast("Appearance theme saved.", "success");
  } catch (error) {
    document.querySelector("#theme-status").textContent = error.message;
    showToast(`Could not save theme: ${error.message}`, "error", 5000);
    log("error", "theme.save-failed", { error });
  }
});

document.querySelector("#qol-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.querySelector("#qol-save");
  const status = document.querySelector("#qol-status");
  submit.disabled = true;
  form.setAttribute("aria-busy", "true");
  status.textContent = "Saving preferences…";
  try {
    const result = await window.quietBrowser.saveQolSettings(readQolFormSettings());
    applyQolSettings(result.settings, result.assets);
    status.textContent = "Preferences saved.";
    showToast("Browsing preferences saved.", "success");
  } catch (error) {
    status.textContent = `Could not save preferences: ${error.message}`;
    showToast(`Could not save preferences: ${error.message}`, "error", 5000);
    log("error", "settings.qol-save-failed", { error });
  } finally {
    submit.disabled = false;
    form.removeAttribute("aria-busy");
  }
});
document.querySelectorAll("#qol-form input[type='checkbox']").forEach((input) => {
  input.addEventListener("change", () => {
    document.querySelector("#qol-form").requestSubmit();
  });
});

async function changeAppearanceAsset(kind, remove = false) {
  const status = document.querySelector("#qol-status");
  status.textContent = remove ? "Removing image…" : "Choose an image in the file picker.";
  try {
    const result = remove
      ? await window.quietBrowser.removeAppearanceAsset(kind)
      : await window.quietBrowser.importAppearanceAsset(kind);
    if (!result) {
      status.textContent = "Image selection canceled.";
      return;
    }
    applyQolSettings(result.settings, result.assets, false);
    const message = remove
      ? `${kind === "cursor" ? "Cursor" : "Wallpaper"} reset to default.`
      : `${kind === "cursor" ? "Cursor" : "Wallpaper"} image applied.`;
    status.textContent = message;
    showToast(message, "success");
  } catch (error) {
    status.textContent = `Could not update ${kind}: ${error.message}`;
    showToast(`Could not update ${kind}: ${error.message}`, "error", 5000);
    log("error", "appearance.asset-change-failed", { kind, remove, error });
  }
}

document.querySelector("#choose-cursor").addEventListener("click", () => {
  changeAppearanceAsset("cursor");
});
document.querySelector("#remove-cursor").addEventListener("click", () => {
  changeAppearanceAsset("cursor", true);
});
document.querySelector("#choose-wallpaper").addEventListener("click", () => {
  changeAppearanceAsset("wallpaper");
});
document.querySelector("#remove-wallpaper").addEventListener("click", () => {
  changeAppearanceAsset("wallpaper", true);
});

document.addEventListener("click", (event) => {
  if (
    event.isTrusted &&
    event.target instanceof Element &&
    event.target.closest("button:not(:disabled)")
  ) {
    playInterfaceSound("click");
  }
});
document.addEventListener("input", (event) => {
  const target = event.target;
  if (
    !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) ||
    !isTypingSoundTarget({
      trusted: event.isTrusted,
      tagName: target.tagName,
      type: target.type,
      insideBrowserForm: Boolean(
        target.closest("#address-form, .start-search, #theme-form, #qol-form")
      )
    })
  ) return;
  playInterfaceSound("typing");
});

document.querySelector("#theme-reset").addEventListener("click", () => {
  for (const [key, value] of Object.entries(window.QuietTheme.DEFAULT_THEME)) {
    themeForm.elements.namedItem(key).value = value;
  }
  themeForm.dispatchEvent(new Event("input", { bubbles: true }));
});
document.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (modifier && event.shiftKey && key === "o") {
    event.preventDefault();
    document.querySelector("#library-button").click();
  } else if (modifier && event.shiftKey && key === "b") {
    event.preventDefault();
    document.querySelector("#bookmarks-bar").classList.toggle("hidden");
  } else if (modifier && event.shiftKey && key === "tab") {
    event.preventDefault();
    const tab = activeTab();
    if (tab) activateTab(tabs[(tabs.indexOf(tab) - 1 + tabs.length) % tabs.length].id);
  } else if (modifier && key === "l") {
    event.preventDefault();
    addressInput.focus();
    addressInput.select();
  } else if (modifier && key === "t") {
    event.preventDefault();
    createTab();
  } else if (modifier && key === "w") {
    event.preventDefault();
    closeTab(activeTabId);
  } else if (modifier && key === "d") {
    event.preventDefault();
    document.querySelector("#bookmark").click();
  } else if (modifier && key === "r" || key === "f5") {
    event.preventDefault();
    document.querySelector("#reload").click();
  } else if (modifier && key === "tab") {
    event.preventDefault();
    const tab = activeTab();
    if (tab) activateTab(tabs[(tabs.indexOf(tab) + 1) % tabs.length].id);
  } else if (event.altKey && key === "arrowleft") {
    event.preventDefault();
    backButton.click();
  } else if (event.altKey && key === "arrowright") {
    event.preventDefault();
    forwardButton.click();
  }
});

createTab();
initializeSettings();
