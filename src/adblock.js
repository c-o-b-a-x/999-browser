const RESOURCE_TYPES = new Set([
  "document",
  "script",
  "image",
  "stylesheet",
  "font",
  "xmlhttprequest",
  "subdocument",
  "media",
  "ping",
  "other",
  "object",
  "websocket"
]);

function parseRule(line) {
  const source = line.trim();
  if (!source || source.startsWith("!") || source.startsWith("[")) return null;
  const exception = source.startsWith("@@");
  const body = exception ? source.slice(2) : source;
  const separator = body.indexOf("$");
  const pattern = separator === -1 ? body : body.slice(0, separator);
  const options = separator === -1 ? [] : body.slice(separator + 1).split(",");
  if (!pattern || pattern.length > 500) return null;

  const includedTypes = new Set();
  const excludedTypes = new Set();
  const includedDomains = new Set();
  const excludedDomains = new Set();
  let thirdParty = null;
  let matchCase = false;
  for (const option of options) {
    const [rawName, rawValue] = option.split("=", 2);
    const name = rawName.toLowerCase();
    if (RESOURCE_TYPES.has(name)) includedTypes.add(name);
    else if (RESOURCE_TYPES.has(name.slice(1)) && name.startsWith("~")) {
      excludedTypes.add(name.slice(1));
    } else if (name === "third-party") thirdParty = true;
    else if (name === "~third-party") thirdParty = false;
    else if (name === "match-case") matchCase = true;
    else if (name === "domain" && rawValue) {
      for (const domain of rawValue.split("|")) {
        if (domain.startsWith("~")) excludedDomains.add(domain.slice(1).toLowerCase());
        else includedDomains.add(domain.toLowerCase());
      }
    }
  }

  return {
    exception,
    includedTypes,
    excludedTypes,
    includedDomains,
    excludedDomains,
    thirdParty,
    regex: compilePattern(pattern, matchCase)
  };
}

function compilePattern(pattern, matchCase) {
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1), matchCase ? "" : "i");
    } catch {
      return null;
    }
  }
  let expression = pattern;
  let prefixAnchor = false;
  let domainAnchor = false;
  let suffixAnchor = false;
  if (expression.startsWith("||")) {
    expression = expression.slice(2);
    domainAnchor = true;
  } else if (expression.startsWith("|")) {
    expression = expression.slice(1);
    prefixAnchor = true;
  }
  if (expression.endsWith("|")) {
    expression = expression.slice(0, -1);
    suffixAnchor = true;
  }
  let output = "";
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "*") output += ".*";
    else if (character === "^") output += "(?:[^a-zA-Z0-9_.%-]|$)";
    else output += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    const anchor = domainAnchor
      ? `^(?:https?:\\/\\/)?${expression.startsWith("/") ? "[^/]+" : "(?:[^/]+\\.)*"}`
      : prefixAnchor
        ? "^"
        : "";
    return new RegExp(`${anchor}${output}${suffixAnchor ? "$" : ""}`, matchCase ? "" : "i");
  } catch {
    return null;
  }
}

function domainMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au",
  "co.nz", "org.nz", "co.jp", "co.kr", "com.br", "com.mx",
  "com.sg", "com.tr", "co.in"
]);

function registrableDomain(hostname) {
  const labels = hostname.split(".");
  if (labels.length < 2) return hostname;
  const suffix = labels.slice(-2).join(".");
  const suffixLength = MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2;
  return labels.slice(-suffixLength).join(".");
}

function ruleApplies(rule, requestUrl, firstPartyUrl, resourceType) {
  const normalizedType = {
    mainframe: "document",
    subframe: "subdocument",
    xhr: "xmlhttprequest",
    fetch: "xmlhttprequest",
    cspreport: "other"
  }[resourceType.toLowerCase()] || resourceType.toLowerCase();
  if (
    !rule.regex ||
    (rule.includedTypes.size && !rule.includedTypes.has(normalizedType))
  ) return false;
  if (rule.excludedTypes.has(normalizedType)) return false;
  let request;
  let firstParty;
  try {
    request = new URL(requestUrl);
    firstParty = new URL(firstPartyUrl);
  } catch {
    return false;
  }
  const isThirdParty =
    registrableDomain(request.hostname) !== registrableDomain(firstParty.hostname);
  if (rule.thirdParty !== null && isThirdParty !== rule.thirdParty) return false;
  if ([...rule.excludedDomains].some((domain) => domainMatches(firstParty.hostname, domain))) {
    return false;
  }
  if (
    rule.includedDomains.size &&
    ![...rule.includedDomains].some((domain) => domainMatches(firstParty.hostname, domain))
  ) return false;
  return rule.regex.test(requestUrl);
}

function createFilterEngine(lines) {
  const rules = lines.map(parseRule).filter((rule) => rule?.regex);
  return {
    ruleCount: rules.length,
    shouldBlock(requestUrl, firstPartyUrl, resourceType) {
      if (rules.some(
        (rule) =>
          rule.exception &&
          ruleApplies(rule, requestUrl, firstPartyUrl, resourceType)
      )) return false;
      return rules.some(
        (rule) =>
          !rule.exception &&
          ruleApplies(rule, requestUrl, firstPartyUrl, resourceType)
      );
    }
  };
}

module.exports = { createFilterEngine, parseRule };
