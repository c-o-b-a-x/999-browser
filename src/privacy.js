const TRACKER_HOSTS = [
  "adnxs.com",
  "adsrvr.org",
  "adservice.google.com",
  "analytics.tiktok.com",
  "app-measurement.com",
  "bat.bing.com",
  "branch.io",
  "clarity.ms",
  "connect.facebook.net",
  "criteo.com",
  "demdex.net",
  "doubleclick.net",
  "googletagmanager.com",
  "google-analytics.com",
  "hotjar.com",
  "mixpanel.com",
  "omtrdc.net",
  "outbrain.com",
  "scorecardresearch.com",
  "segment.io",
  "taboola.com",
  "track.hubspot.com",
  "quantserve.com",
  "ads-twitter.com"
];

function normalizeAddress(input) {
  const value = input.trim();
  if (!value) return "";

  try {
    if (/^https?:\/\//i.test(value)) {
      return new URL(value).href;
    }

    const isHostPort = /^[^/\s:]+:\d+(?:[/?#]|$)/.test(value);
    const hasScheme =
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) && !isHostPort;
    if (!hasScheme) {
      const candidate = new URL(`https://${value}`);
      const hostname = candidate.hostname.toLowerCase();
      const isIpAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
      const isRecognizableHost =
        hostname === "localhost" || hostname.includes(".") || isIpAddress;
      if (!/\s/.test(value) && isRecognizableHost) {
        return candidate.href;
      }
    }
  } catch {
    // Treat non-URL input as a search query.
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

function isTrackerUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return TRACKER_HOSTS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

const privacy = { isTrackerUrl, normalizeAddress };
if (typeof module !== "undefined" && module.exports) {
  module.exports = privacy;
} else {
  globalThis.QuietPrivacy = privacy;
}
