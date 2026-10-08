const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { markFirstRunComplete, shouldShowFirstRun } = require("../src/first-run");

test("shows onboarding only for a fresh profile and remembers completion", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "no-peepers-first-run-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "first-run-complete");
  const browserData = path.join(directory, "browser-data.json");
  const passwordVault = path.join(directory, "password-vault.json");

  assert.equal(shouldShowFirstRun(marker, [browserData, passwordVault]), true);

  markFirstRunComplete(marker);
  assert.equal(fs.readFileSync(marker, "utf8"), "completed\n");
  assert.equal(shouldShowFirstRun(marker, [browserData, passwordVault]), false);
});

test("does not show first-run onboarding to profiles with existing browser data", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "no-peepers-existing-profile-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "first-run-complete");
  const browserData = path.join(directory, "browser-data.json");
  fs.writeFileSync(browserData, "{}");

  assert.equal(shouldShowFirstRun(marker, [browserData]), false);
});

test("connects the first-run walkthrough to the password setup and completion APIs", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");

  assert.equal((html.match(/data-onboarding-step=/g) || []).length, 5);
  assert.match(html, /id="onboarding-password-form"/);
  assert.match(renderer, /await window\.quietBrowser\.setupPasswordManager\(/);
  assert.match(renderer, /await window\.quietBrowser\.completeOnboarding\(\)/);
  assert.match(preload, /completeOnboarding: \(\) => ipcRenderer\.invoke\("onboarding:complete"\)/);
});
