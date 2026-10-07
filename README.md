# Quiet Browser

A small Electron desktop browser focused on keeping browsing data on your device.

## Run

1. Install Node.js 22.12 or newer.
2. Run `npm install`.
3. Run `npm start`.

## Privacy behavior

- The app has no account, analytics, or telemetry integration.
- History, bookmarks, and cookies are stored locally; history and cookies can be cleared in Privacy settings.
- Ad blocking uses a bundled local filter list plus common tracker-domain blocking. The built-in rules support common EasyList-style host/path patterns, resource types, domain scopes, and exceptions; this is not the complete EasyList format. No external filter service is contacted. Blocking is not comprehensive and can affect some sites.
- Browser configuration is organized under the Settings button in the top toolbar, with separate General, Appearance, Privacy & Security, and Passwords sections. History and bookmarks remain in their own library.
- Saved passwords are encrypted using Electron's operating-system secure storage. The browser asks before saving or filling credentials, and only offers autofill for the exact HTTPS site that saved them (localhost is allowed for development). Manage saved logins in Settings → Passwords.
- Settings → Appearance lets you adjust interface colors, font, control color scheme, text size, and corner roundness. Theme preferences are stored locally.
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
