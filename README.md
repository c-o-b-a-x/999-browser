# no peepers

no peepers is a small Electron desktop browser focused on keeping browsing data on your device.

## Run

1. Install Node.js 22.12 or newer.
2. Run `npm install`.
3. Run `npm start`.

## Privacy behavior

- The app has no account, analytics, or telemetry integration.
- History, bookmarks, and cookies are stored locally; history and cookies can be cleared in Privacy settings.
- Ad blocking uses a bundled local filter list plus common tracker-domain blocking. The built-in rules support common EasyList-style host/path patterns, resource types, domain scopes, and exceptions; this is not the complete EasyList format. No external filter service is contacted. Blocking is not comprehensive and can affect some sites.
- Browser configuration is organized under the Settings button in the top toolbar, with separate General, Appearance, Privacy & Security, and Passwords sections. History and bookmarks remain in their own library.
- On a fresh profile, a short first-run tour points out tabs, navigation, search, the library, Settings, and privacy controls. It offers password-manager setup with a master password and recovery PIN; setup can be completed later from Settings → Passwords.
- `CHANGELOG.md` records notable changes. When enabled, the browser checks the public GitHub changelog at startup and shows unseen notes in a What's New dialog. The dialog's checkbox opts out of future checks; this can be changed later in Settings → General. The check contacts GitHub, which receives the normal connection metadata for an HTTPS request; no browsing history or credentials are sent.
- The Passwords manager requires a master password of at least 12 characters. Passwords remain hidden until individually revealed, and the manager locks when you leave its Settings section or close Settings. A user-chosen 4–6 digit recovery PIN can reset a forgotten master password; failed recovery attempts are throttled. The PIN is a recovery gate layered with OS secure storage, not a standalone encryption key.
- After a trusted sign-in form submission, no peepers offers to save the credentials, including sites that submit through JavaScript buttons. Credential values are never written to diagnostic logs.
- Vault credentials are encrypted at rest with AES-256-GCM. A random vault key is wrapped separately by a master-password-derived key and by the operating system's secure storage. The OS-wrapped key keeps origin-checked, explicitly confirmed autofill available while the Passwords manager is locked. This means the master password protects manual access in the manager, not a compromised app or malware already running as your OS user. Existing OS-encrypted saved logins are migrated when the manager is first set up.
- Settings → Appearance lets you adjust interface colors, font, control color scheme, text size, and corner roundness. Theme preferences are stored locally.
- Settings → Appearance also offers opt-in forced page darkening, local custom cursor images for browser chrome and websites, and a local new-tab wallpaper. Cursor PNG files are limited to 128 × 128 pixels; wallpapers support PNG/JPEG. Imported images are copied into app-managed local storage.
- Interface typing and click sounds have separate toggles and default to on. Typing sounds are limited to browser UI fields; website contents and password/recovery fields are never sampled for sounds. Effects are generated locally and no audio is sent or downloaded.
- Settings → Appearance lets you show or hide each new-tab element independently: no peepers branding, headline, intro text, search bar, and privacy note. All are shown by default.
- Browser actions provide accessible status feedback; page loading has a progress indicator, and keyboard focus/hover/pressed/disabled states are visibly styled. Reduced-motion preferences are respected.
- Requests carry Do Not Track and Global Privacy Control signals. These are requests to websites, not technical enforcement.
- Site permission requests (including location, camera, microphone, and notifications) are denied.
- Search terms entered without an address are sent to DuckDuckGo. Visited websites still receive the connection information needed to serve their pages.
- Detailed diagnostic logs are stored locally in the app's `logs` folder, available from Settings → Privacy & Security. Logs rotate at 5 MB and keep up to three previous files. URL query strings, paths, and fragments are redacted to avoid recording search terms or page-specific URL data. Log files contain lifecycle, navigation failure, blocked tracker, permission-denial, renderer, and local-data events; review them before sharing.

This is an early, lightweight browser, not a substitute for a mature privacy-focused browser. It does not attempt to defeat fingerprinting or provide anonymity.

## Shortcuts

- `Ctrl+L`: focus the address bar
- `Ctrl+T`: open a tab
- `Ctrl+W`: close the current tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: move between tabs
- `Ctrl+D`: bookmark the current page
- `Ctrl+Shift+B`: show or hide the bookmarks bar
- `Ctrl+Shift+O`: open history and bookmarks
- `Ctrl+R` / `F5`: reload the current page
- `Alt+Left` / `Alt+Right`: navigate backward / forward

Canceled or superseded page navigations (`ERR_ABORTED`, Electron error `-3`) are treated as normal browser behavior instead of being shown as page-load errors. Other top-level navigation failures are displayed with their Chromium error code and can be retried.
