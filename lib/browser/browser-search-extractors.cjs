"use strict";

const BROWSER_SEARCH_PROVIDERS = Object.freeze({
  bing_browser: Object.freeze({
    id: "bing_browser",
    engine: "bing",
    label: "Bing Browser",
    baseUrl: "https://www.bing.com/search",
    params: (query, maxResults) => ({ q: query, count: String(maxResults) }),
  }),
  google_browser: Object.freeze({
    id: "google_browser",
    engine: "google",
    label: "Google Browser",
    baseUrl: "https://www.google.com/search",
    params: (query, maxResults) => ({ q: query, num: String(maxResults) }),
  }),
  duckduckgo_browser: Object.freeze({
    id: "duckduckgo_browser",
    engine: "duckduckgo",
    label: "DuckDuckGo Browser",
    baseUrl: "https://duckduckgo.com/",
    params: (query) => ({ q: query, kl: "wt-wt" }),
  }),
});

const BROWSER_SEARCH_PROVIDER_IDS = Object.freeze([
  "bing_browser",
  "google_browser",
  "duckduckgo_browser",
]);

function assertBrowserSearchProvider(provider) {
  if (!BROWSER_SEARCH_PROVIDERS[provider]) {
    throw new Error(`Unknown browser search provider: ${provider}`);
  }
}

function normalizeBrowserLocale(locale) {
  const normalized = String(locale || "").trim();
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(normalized) ? normalized : "";
}

function buildBrowserSearchLoadOptions(provider, { locale } = {}) {
  assertBrowserSearchProvider(provider);
  const normalizedLocale = normalizeBrowserLocale(locale);
  const language = normalizedLocale.split("-")[0] || "en";
  return {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    extraHeaders: normalizedLocale
      ? `Accept-Language: ${normalizedLocale},${language};q=0.9,en;q=0.8`
      : "Accept-Language: en-US,en;q=0.9",
  };
}

function buildBrowserSearchUrl(provider, query, maxResults = 5, { locale } = {}) {
  assertBrowserSearchProvider(provider);
  const def = BROWSER_SEARCH_PROVIDERS[provider];
  const url = new URL(def.baseUrl);
  const params = def.params(String(query || "").trim(), Math.max(1, Math.min(10, Number(maxResults) || 5)));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const normalizedLocale = normalizeBrowserLocale(locale);
  if (provider === "bing_browser" && normalizedLocale) {
    url.searchParams.set("mkt", normalizedLocale);
    url.searchParams.set("setlang", normalizedLocale);
    const country = normalizedLocale.split("-")[1];
    if (country) url.searchParams.set("cc", country);
  }
  return url.toString();
}

function buildBrowserSearchExtractionScript(provider, maxResults = 5) {
  assertBrowserSearchProvider(provider);
  const engine = BROWSER_SEARCH_PROVIDERS[provider].engine;
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 5));
  return `(() => {
    const engine = ${JSON.stringify(engine)};
    const maxResults = ${limit};

    function textOf(el) {
      return (el && (el.innerText || el.textContent) || "").replace(/\\s+/g, " ").trim();
    }

    function firstText(root, selectors) {
      for (const selector of selectors) {
        const el = root.querySelector(selector);
        const text = textOf(el);
        if (text) return text;
      }
      return "";
    }

    function firstAnchor(root, selectors) {
      for (const selector of selectors) {
        const el = root.querySelector(selector);
        if (el && el.href) return el;
      }
      return null;
    }

    function cleanUrl(raw) {
      if (!raw) return "";
      let url;
      try {
        url = new URL(raw, location.href);
      } catch {
        return "";
      }

      if (url.hostname.endsWith("google.com") && url.pathname === "/url" && url.searchParams.get("q")) {
        try { url = new URL(url.searchParams.get("q")); } catch {}
      }
      if (url.hostname.endsWith("duckduckgo.com") && url.pathname.startsWith("/l/") && url.searchParams.get("uddg")) {
        try { url = new URL(url.searchParams.get("uddg")); } catch {}
      }
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.href;
    }

    function displayUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\\./, "") + parsed.pathname.replace(/\\/$/, "");
      } catch {
        return "";
      }
    }

    function hasCaptchaSignals() {
      const bodyText = textOf(document.body).toLowerCase();
      const href = location.href.toLowerCase();
      return (
        href.includes("/sorry/") ||
        href.includes("captcha") ||
        bodyText.includes("unusual traffic") ||
        bodyText.includes("verify you are human") ||
        bodyText.includes("detected unusual traffic") ||
        bodyText.includes("our systems have detected") ||
        bodyText.includes("enter the characters you see below")
      );
    }

    function blockedReason() {
      if (hasCaptchaSignals()) return "Search page requires verification or CAPTCHA.";
      const bodyText = textOf(document.body).toLowerCase();
      if (bodyText.includes("enable javascript")) return "Search page requires JavaScript.";
      if (bodyText.includes("consent") && bodyText.includes("privacy")) return "Search page is blocked by a consent interstitial.";
      return "";
    }

    function resultFrom(root, anchor, title, snippet, rank) {
      const url = cleanUrl(anchor && anchor.href);
      if (!title || !url) return null;
      return {
        title,
        url,
        content: snippet || "",
        rank,
        score: null,
        metadata: {
          display_url: displayUrl(url),
          engine,
        },
      };
    }

    function bingResults() {
      const items = Array.from(document.querySelectorAll("li.b_algo, .b_algo"));
      return items.map((item, idx) => {
        const anchor = firstAnchor(item, ["h2 a", "a"]);
        const title = firstText(item, ["h2", "a"]);
        const snippet = firstText(item, [".b_caption p", ".b_snippet", "p"]);
        return resultFrom(item, anchor, title, snippet, idx + 1);
      }).filter(Boolean);
    }

    function googleResults() {
      const items = Array.from(document.querySelectorAll("div.g, div.MjjYud, div[data-sokoban-container]"));
      return items.map((item, idx) => {
        const anchor = firstAnchor(item, ["a:has(h3)", "a"]);
        const title = firstText(item, ["h3"]);
        const snippet = firstText(item, [".VwiC3b", ".IsZvec", "[data-sncf]", ".kb0PBd"]);
        return resultFrom(item, anchor, title, snippet, idx + 1);
      }).filter(Boolean);
    }

    function duckduckgoResults() {
      const items = Array.from(document.querySelectorAll("article[data-testid='result'], .result, .web-result"));
      return items.map((item, idx) => {
        const anchor = firstAnchor(item, ["a[data-testid='result-title-a']", "a.result__a", "h2 a", "a"]);
        const title = textOf(anchor) || firstText(item, ["h2", ".result__title"]);
        const snippet = firstText(item, ["[data-result='snippet']", ".result__snippet", ".result__body"]);
        return resultFrom(item, anchor, title, snippet, idx + 1);
      }).filter(Boolean);
    }

    let reason = blockedReason();
    const blocked = !!reason;
    let results = [];
    if (!blocked) {
      if (engine === "bing") results = bingResults();
      else if (engine === "google") results = googleResults();
      else if (engine === "duckduckgo") results = duckduckgoResults();
    }

    const bodyText = textOf(document.body).toLowerCase();
    const noResults = !blocked && results.length === 0 && (
      bodyText.includes("没有与此相关的结果") ||
      bodyText.includes("没有找到相关结果") ||
      bodyText.includes("no results found") ||
      bodyText.includes("did not match any documents")
    );
    const status = blocked
      ? "blocked"
      : results.length > 0
        ? "ok"
        : noResults
          ? "no_results"
          : "extraction_failed";
    if (status === "extraction_failed" && !reason) {
      reason = "Search results could not be extracted from the current page.";
    }

    return {
      title: document.title || "",
      final_url: location.href,
      blocked,
      captcha: hasCaptchaSignals(),
      status,
      reason,
      results: results.slice(0, maxResults).map((item, idx) => ({ ...item, rank: idx + 1 })),
    };
  })()`;
}

module.exports = {
  BROWSER_SEARCH_PROVIDERS,
  BROWSER_SEARCH_PROVIDER_IDS,
  buildBrowserSearchExtractionScript,
  buildBrowserSearchLoadOptions,
  buildBrowserSearchUrl,
};
