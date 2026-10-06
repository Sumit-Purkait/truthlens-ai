const dns = require("node:dns/promises");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { load } = require("cheerio");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Process-level crash prevention to ensure the server stays completely stable
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught exception captured:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRITICAL] Unhandled promise rejection captured:", reason);
});

const app = express();
const PORT = Number(process.env.PORT || 5000);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;

// Google Gemini API Configuration & Endpoints
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_TIMEOUT_MS = 15_000;
const FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-flash-latest", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3-flash-preview"];

function isGeminiKey(key) {
  if (!key || typeof key !== "string") return false;
  const k = key.trim();
  return k.startsWith("AQ.") || k.startsWith("AIzaSy");
}

function getEffectiveBaseUrl(userBaseUrl) {
  if (!userBaseUrl || typeof userBaseUrl !== "string") return GEMINI_API_BASE;
  const trimmed = userBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("/openai") || trimmed.includes("api.openai.com")) {
    return GEMINI_API_BASE;
  }
  return trimmed;
}

function normalizeModel(model) {
  if (!model || typeof model !== "string") return "gemini-3.8-flash";
  const m = model.trim().replace(/\s+/g, "-");
  if (m.toLowerCase().startsWith("gpt") || m.includes("gemini-1.5") || m === "gemini-2.5-flash" || m === "gemini-2.5-pro") {
    return "gemini-3.8-flash";
  }
  return m;
}

// Native Google Gemini REST API Client
async function callGeminiGenerateContent({ apiKey, model, systemPrompt, userPrompt, image, baseUrl, timeoutMs = GEMINI_TIMEOUT_MS }) {
  const activeBase = getEffectiveBaseUrl(baseUrl);
  const endpoint = `${activeBase}/models/${encodeURIComponent(model)}:generateContent`;

  const parts = [];

  if (image && typeof image === "string") {
    let mimeType = "image/jpeg";
    let base64Data = image;
    const match = image.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    }
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Data
      }
    });
  }

  parts.push({ text: userPrompt });

  const payload = {
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048
    }
  };

  if (systemPrompt && typeof systemPrompt === "string") {
    payload.system_instruction = {
      parts: [{ text: systemPrompt }]
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const errMessage = data?.error?.message || `Google Gemini API error (HTTP ${res.status})`;
      const err = new Error(errMessage);
      err.status = res.status;
      err.geminiError = data?.error;
      throw err;
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
    return {
      text,
      modelUsed: model,
      raw: data
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Google Gemini API request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableGeminiError(err) {
  if (!err) return false;
  if (err.status === 503 || err.status === 429) return true;
  if (err.geminiError?.status === "UNAVAILABLE" || err.geminiError?.status === "RESOURCE_EXHAUSTED") return true;
  const msg = (err.message || "").toLowerCase();
  return msg.includes("high demand") || msg.includes("overloaded") || msg.includes("spikes in demand") || msg.includes("rate limit") || msg.includes("quota");
}

async function callGeminiWithFallback({ apiKey, primaryModel, systemPrompt, userPrompt, image, baseUrl, timeoutMs = GEMINI_TIMEOUT_MS }) {
  const modelsToTry = [primaryModel];
  for (const fb of FALLBACK_MODELS) {
    if (!modelsToTry.includes(fb)) modelsToTry.push(fb);
  }

  const RETRY_DELAYS_MS = [1000];
  const MAX_RETRIES = 1;
  let retriesUsed = 0;
  let lastError = null;
  const totalStart = Date.now();

  for (const currentModel of modelsToTry) {
    if (Date.now() - totalStart > 20_000) {
      console.warn(`[Gemini Fallback] Elapsed time exceeded 20s, stopping further model retries.`);
      break;
    }
    while (true) {
      try {
        const result = await callGeminiGenerateContent({
          apiKey,
          model: currentModel,
          systemPrompt,
          userPrompt,
          image,
          baseUrl,
          timeoutMs
        });
        return result;
      } catch (err) {
        lastError = err;

        // Fail immediately only for authentication/permission issues (invalid key)
        if (err.status === 401 || err.geminiError?.status === "PERMISSION_DENIED") {
          throw err;
        }

        // Exponential backoff retry for temporary HTTP 429 rate limit (max 1 retry)
        if (retriesUsed < MAX_RETRIES && (err.status === 429 || err.geminiError?.status === "RESOURCE_EXHAUSTED")) {
          const delayMs = RETRY_DELAYS_MS[retriesUsed] || 1500;
          retriesUsed++;
          console.warn(`[Gemini Retry] Model ${currentModel} returned 429 rate limit. Retrying attempt ${retriesUsed}/${MAX_RETRIES} in ${delayMs}ms...`);
          await sleep(delayMs);
          continue;
        }

        // For 503 high demand or exhausted retries, move immediately to next model in fallback chain
        console.warn(`[Gemini Fallback] Model ${currentModel} returned ${err.status || err.message}. Retrying with next model in chain...`);
        break;
      }
    }
  }
  throw lastError;
}

async function listGeminiModels(apiKey, baseUrl, timeoutMs = 10_000) {
  const activeBase = getEffectiveBaseUrl(baseUrl);
  const endpoint = `${activeBase}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Google Gemini API error (HTTP ${res.status})`);
      err.status = res.status;
      err.geminiError = data?.error;
      throw err;
    }

    return Array.isArray(data?.models) ? data.models : [];
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Connection timed out after ${Math.round(timeoutMs / 1000)}s.`);
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  }
}

const initialKey = (process.env.GEMINI_API_KEY || "").trim();
const initialModel = normalizeModel(process.env.GEMINI_MODEL);
const initialBaseUrl = getEffectiveBaseUrl(process.env.GEMINI_BASE_URL);

// Dynamic Settings Store with live in-memory updates & fallback to .env
const settingsState = {
  apiKey: initialKey,
  model: initialModel,
  baseUrl: initialBaseUrl,
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 60),
  searchDepth: "balanced",
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173,http://localhost:5500,http://localhost:8000,http://127.0.0.1:3000,http://127.0.0.1:5173,http://127.0.0.1:5500,http://127.0.0.1:8000").split(",").map(x => x.trim())
};

// Smart quota exhaustion cache (resets on key update or test)
let quotaExhaustedUntil = 0;

// Mask API key for secure frontend display
function maskKey(key) {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (trimmed.length <= 10) return "••••••••";
  return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`;
}

// Universal Local & Production CORS Configuration
function isOriginAllowed(origin) {
  if (!origin) return true; // allow same-origin, curl, mobile webviews, electron
  if (settingsState.allowedOrigins.includes("*") || settingsState.allowedOrigins.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) {
      return true;
    }
  } catch {}
  return false;
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

// Graceful CORS without crashing Express middleware on unpermitted origins
app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-model", "x-base-url"]
}));

app.use(express.json({ limit: "15mb" }));

// Rate limiter strictly isolated to the verification endpoint (/api/check)
const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => settingsState.rateLimitMax || 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many verification requests. Please adjust rate limit settings or try again shortly." }
});

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

function publicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 2 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (family === 6) {
    const value = ip.toLowerCase();
    if (value.startsWith("::ffff:")) return publicIp(value.slice(7));
    return !(value === "::" || value === "::1" || /^(fc|fd|fe[89ab])/.test(value));
  }
  return false;
}

async function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail("Enter a valid public website URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname) {
    throw fail("Only public HTTP and HTTPS URLs are supported.");
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw fail("Only standard web ports (80, 443) are supported.");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host === "metadata.google.internal"
  ) {
    throw fail("Local, intranet, and cloud metadata addresses cannot be accessed.");
  }
  try {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !publicIp(address))) {
      throw fail("This URL does not resolve to a public address.");
    }
  } catch (err) {
    if (err.expose) throw err;
    throw fail(`Could not resolve host ${url.hostname}. Check the URL.`);
  }
  return url;
}

async function readLimited(response) {
  const cl = Number(response.headers.get("content-length") || 0);
  if (cl > MAX_PAGE_BYTES) throw fail("The webpage is too large to analyse.", 413);
  const reader = response.body?.getReader();
  if (!reader) return "";
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) throw fail("The webpage is too large to analyse.", 413);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normaliseText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function extractReadablePage(html, url) {
  const $ = load(html);
  const title = normaliseText($("title").first().text()) || url.hostname;
  const description = normaliseText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content"));
  const selectors = ["article", "main", "[role='main']", ".article-body", ".article-content", ".entry-content", ".post-content", ".story-body", ".content"];
  const candidates = selectors.map((selector) => normaliseText($(selector).text())).filter(Boolean);
  const cleanedBody = $("body").clone();
  cleanedBody.find("script,style,noscript,svg,nav,footer,header,aside,form,iframe,button,dialog").remove();
  candidates.push(normaliseText(cleanedBody.text()));
  const text = candidates.sort((a, b) => b.length - a.length)[0] || "";
  const context = normaliseText([title, description, text].filter(Boolean).join("\n")).slice(0, 18_000);
  return { url: url.href, title: title.slice(0, 250), domain: url.hostname, text: context, readable: text.length >= 80 };
}

async function fetchPage(value) {
  let url = await safeUrl(value);
  for (let count = 0; count <= 3; count += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 FACTSIFT-AI/2.0", Accept: "text/html,application/xhtml+xml" }
      });
    } catch (error) {
      throw error.name === "AbortError" ? fail("The webpage took too long to respond (timeout).", 504) : fail("The webpage could not be accessed.", 422);
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const to = response.headers.get("location");
      if (!to || count === 3) throw fail("The webpage redirected too many times.", 422);
      url = await safeUrl(new URL(to, url).href);
      continue;
    }
    if (!response.ok) throw fail(`Webpage returned status ${response.status}. It may require login.`, 422);
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")) {
      throw fail("That URL did not return a readable webpage.", 422);
    }
    return extractReadablePage(await readLimited(response), url);
  }
}

function validateImage(image) {
  if (!image) return;
  if (typeof image !== "string" || !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image)) {
    throw fail("Upload a valid PNG, JPEG, WebP, or GIF image.");
  }
  if (Buffer.byteLength(image.slice(image.indexOf(",") + 1), "base64") > MAX_IMAGE_BYTES) {
    throw fail("The image must be 10 MB or smaller.", 413);
  }
}

function parseAnalysis(rawText) {
  const take = (label) => rawText.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n(?:VERDICT|CONFIDENCE|EXPLANATION|EVIDENCE|SELECTED_SOURCES|BREAKDOWN):|$)`, "i"))?.[1]?.trim();
  const verdictRaw = (take("VERDICT") || "").toUpperCase();
  let verdict = "UNCERTAIN";
  if (verdictRaw.includes("TRUE")) verdict = "TRUE";
  else if (verdictRaw.includes("FALSE")) verdict = "FALSE";
  else if (verdictRaw.includes("MISLEADING")) verdict = "MISLEADING";
  else if (verdictRaw.includes("UNCERTAIN")) verdict = "UNCERTAIN";

  const confMatch = (take("CONFIDENCE") || "0").match(/\d+/);
  const confidence = confMatch ? Math.min(100, Math.max(0, Number(confMatch[0]))) : (verdict === "UNCERTAIN" ? 45 : 85);
  const explanation = take("EXPLANATION") || rawText.trim();
  const evidence = take("EVIDENCE") || "Evidence analyzed across available public records and factual databases.";

  return { verdict, confidence, explanation, evidence };
}

// -------------------------------------------------------------
// PHASE 4: AUTHORITATIVE SOURCE SEARCH & CLASSIFICATION ENGINE
// -------------------------------------------------------------

const KNOWN_PUBLISHERS = {
  // Official Indian Government & Institutions
  'pmindia.gov.in': { publisher: "Prime Minister's Office (India)", type: 'Official Government Source', isPrimary: true },
  'pib.gov.in': { publisher: 'Press Information Bureau (Govt of India)', type: 'Official Government Source', isPrimary: true },
  'eci.gov.in': { publisher: 'Election Commission of India', type: 'Official Government Source', isPrimary: true },
  'sansad.in': { publisher: 'Parliament of India', type: 'Official Government Source', isPrimary: true },
  'india.gov.in': { publisher: 'National Portal of India', type: 'Official Government Source', isPrimary: true },
  'sci.gov.in': { publisher: 'Supreme Court of India', type: 'Official Government Source', isPrimary: true },
  'mha.gov.in': { publisher: 'Ministry of Home Affairs (India)', type: 'Official Government Source', isPrimary: true },
  'mea.gov.in': { publisher: 'Ministry of External Affairs (India)', type: 'Official Government Source', isPrimary: true },
  'rbi.org.in': { publisher: 'Reserve Bank of India', type: 'Official Government Source', isPrimary: true },
  'isro.gov.in': { publisher: 'Indian Space Research Organisation (ISRO)', type: 'Official Government Source', isPrimary: true },
  
  // Official International Governments & Organizations
  'whitehouse.gov': { publisher: 'The White House (US)', type: 'Official Government Source', isPrimary: true },
  'state.gov': { publisher: 'US Department of State', type: 'Official Government Source', isPrimary: true },
  'gov.uk': { publisher: 'UK Government Portal', type: 'Official Government Source', isPrimary: true },
  'un.org': { publisher: 'United Nations', type: 'Primary Source', isPrimary: true },
  'who.int': { publisher: 'World Health Organization (WHO)', type: 'Primary Source', isPrimary: true },
  'cdc.gov': { publisher: 'Centers for Disease Control and Prevention (CDC)', type: 'Official Government Source', isPrimary: true },
  'nih.gov': { publisher: 'National Institutes of Health (NIH)', type: 'Official Government Source', isPrimary: true },
  'worldbank.org': { publisher: 'World Bank', type: 'Primary Source', isPrimary: true },
  
  // Official Science, Space & Academic Institutions
  'nasa.gov': { publisher: 'NASA', type: 'Official Government Source', isPrimary: true },
  'science.nasa.gov': { publisher: 'NASA Science', type: 'Official Government Source', isPrimary: true },
  'esa.int': { publisher: 'European Space Agency (ESA)', type: 'Primary Source', isPrimary: true },
  'nature.com': { publisher: 'Nature Publishing', type: 'Primary Source', isPrimary: true },
  'science.org': { publisher: 'Science Magazine / AAAS', type: 'Primary Source', isPrimary: true },
  'thelancet.com': { publisher: 'The Lancet', type: 'Primary Source', isPrimary: true },
  'sciencedirect.com': { publisher: 'ScienceDirect Academic', type: 'Primary Source', isPrimary: true },
  
  // Reputable Secondary Sources (Independent News Wires & Established Press)
  'reuters.com': { publisher: 'Reuters', type: 'Reputable News Source', isPrimary: false },
  'apnews.com': { publisher: 'Associated Press (AP)', type: 'Reputable News Source', isPrimary: false },
  'afp.com': { publisher: 'Agence France-Presse (AFP)', type: 'Reputable News Source', isPrimary: false },
  'bbc.com': { publisher: 'BBC News', type: 'Reputable News Source', isPrimary: false },
  'bbc.co.uk': { publisher: 'BBC News', type: 'Reputable News Source', isPrimary: false },
  'thehindu.com': { publisher: 'The Hindu', type: 'Reputable News Source', isPrimary: false },
  'indianexpress.com': { publisher: 'The Indian Express', type: 'Reputable News Source', isPrimary: false },
  'hindustantimes.com': { publisher: 'Hindustan Times', type: 'Reputable News Source', isPrimary: false },
  'ndtv.com': { publisher: 'NDTV', type: 'Reputable News Source', isPrimary: false },
  'indiatoday.in': { publisher: 'India Today', type: 'Reputable News Source', isPrimary: false },
  'bloomberg.com': { publisher: 'Bloomberg News', type: 'Reputable News Source', isPrimary: false },
  'wsj.com': { publisher: 'The Wall Street Journal', type: 'Reputable News Source', isPrimary: false },
  'nytimes.com': { publisher: 'The New York Times', type: 'Reputable News Source', isPrimary: false },
  'theguardian.com': { publisher: 'The Guardian', type: 'Reputable News Source', isPrimary: false },
  'dw.com': { publisher: 'Deutsche Welle (DW)', type: 'Reputable News Source', isPrimary: false },
  
  // Established Fact-Checking Bureaus & Public References
  'snopes.com': { publisher: 'Snopes', type: 'Public Reference', isPrimary: false },
  'factcheck.org': { publisher: 'FactCheck.org', type: 'Public Reference', isPrimary: false },
  'altnews.in': { publisher: 'Alt News', type: 'Public Reference', isPrimary: false },
  'boomlive.in': { publisher: 'BOOM Live', type: 'Public Reference', isPrimary: false },
  'en.wikipedia.org': { publisher: 'Wikipedia', type: 'Public Reference', isPrimary: false },
  'britannica.com': { publisher: 'Encyclopaedia Britannica', type: 'Public Reference', isPrimary: false },

  // Official International Sports & Global Governing Bodies
  'fia.com': { publisher: "FIA (Fédération Internationale de l'Automobile)", type: 'Primary Source', isPrimary: true },
  'formula1.com': { publisher: 'Formula 1 (Official)', type: 'Primary Source', isPrimary: true },
  'fifa.com': { publisher: 'FIFA (Official)', type: 'Primary Source', isPrimary: true },
  'olympics.com': { publisher: 'International Olympic Committee (IOC)', type: 'Primary Source', isPrimary: true },
  'icc-cricket.com': { publisher: 'International Cricket Council (ICC)', type: 'Primary Source', isPrimary: true },
  'wto.org': { publisher: 'World Trade Organization (WTO)', type: 'Primary Source', isPrimary: true },
  'imf.org': { publisher: 'International Monetary Fund (IMF)', type: 'Primary Source', isPrimary: true },
  'interpol.int': { publisher: 'INTERPOL', type: 'Primary Source', isPrimary: true },
  'wada-ama.org': { publisher: 'World Anti-Doping Agency (WADA)', type: 'Primary Source', isPrimary: true },
  'oecd.org': { publisher: 'OECD', type: 'Primary Source', isPrimary: true }
};

const ALLOWED_SOURCE_TYPES = new Set([
  'Official Government Source',
  'Primary Source',
  'Reputable News Source',
  'Public Reference',
  'Verified Web Resource',
  'Submitted Page'
]);

function normalizeSourceType(type) {
  if (ALLOWED_SOURCE_TYPES.has(type)) return type;
  if (/government|court|parliament|ministry|official/i.test(type)) return 'Official Government Source';
  if (/primary|journal|scientific|academic|health/i.test(type)) return 'Primary Source';
  if (/news|press|reuters|ap|wire/i.test(type)) return 'Reputable News Source';
  if (/fact|reference|encyclopedia|wiki/i.test(type)) return 'Public Reference';
  return 'Verified Web Resource';
}

function cleanSourceUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'gclid', 'fbclid', 'ocid'];
    for (const p of trackingParams) u.searchParams.delete(p);
    return u.toString().replace(/\/$/, '');
  } catch {
    return rawUrl;
  }
}

function classifyDomain(domain) {
  const d = (domain || '').toLowerCase().replace(/^www\./, '');
  if (KNOWN_PUBLISHERS[d]) {
    const p = KNOWN_PUBLISHERS[d];
    return { domain: d, publisher: p.publisher, type: normalizeSourceType(p.type), isPrimary: p.isPrimary };
  }
  for (const [key, val] of Object.entries(KNOWN_PUBLISHERS)) {
    if (d === key || d.endsWith('.' + key)) {
      return { domain: d, publisher: val.publisher, type: normalizeSourceType(val.type), isPrimary: val.isPrimary };
    }
  }
  if (/\.gov(\.[a-z]{2})?$/i.test(d) || /\.nic\.in$/i.test(d)) {
    return { domain: d, publisher: 'Government Official Website', type: 'Official Government Source', isPrimary: true };
  }
  if (/\.int$/i.test(d)) {
    return { domain: d, publisher: 'International Official Organization', type: 'Primary Source', isPrimary: true };
  }
  if (/\.edu(\.[a-z]{2})?$/i.test(d) || /\.ac\.[a-z]{2}$/i.test(d)) {
    return { domain: d, publisher: 'Academic Institution', type: 'Primary Source', isPrimary: true };
  }
  const root = d.split('.')[0];
  const capitalized = root.charAt(0).toUpperCase() + root.slice(1);
  return { domain: d, publisher: capitalized, type: 'Verified Web Resource', isPrimary: false };
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "at", "to", "for", "with", "by", "about", "against", "between",
  "into", "through", "during", "before", "after", "above", "below", "from",
  "up", "down", "out", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how", "all",
  "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "can", "will", "just", "should", "now", "says", "said", "claim", "claims",
  "that", "this", "these", "those", "what", "which", "who", "whom", "whose",
  "and", "but", "if", "or", "because", "as", "until", "while", "of"
]);

function getClaimTokens(text) {
  const baseTokens = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
  
  const tokenSet = new Set(baseTokens);
  if (tokenSet.has("pm")) {
    tokenSet.add("prime");
    tokenSet.add("minister");
    tokenSet.add("pmo");
  }
  if (tokenSet.has("cm")) {
    tokenSet.add("chief");
    tokenSet.add("minister");
  }
  if (tokenSet.has("jwst")) {
    tokenSet.add("james");
    tokenSet.add("webb");
  }
  return Array.from(tokenSet);
}

function extractCoreSearchQuery(text) {
  if (!text || typeof text !== "string") return "";
  const rawWords = text.trim().split(/\s+/).filter(Boolean);
  if (rawWords.length <= 4) return text.trim();

  const entityWords = [];
  const nonStopWords = [];

  for (const raw of rawWords) {
    const clean = raw.replace(/[^\w]/g, "");
    if (!clean || clean.length < 2) continue;
    const lower = clean.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;

    const isCapitalized = /^[A-Z0-9]/.test(raw) || /^[A-Z]{2,}$/.test(clean);
    if (isCapitalized) {
      entityWords.push(clean);
    }
    nonStopWords.push(clean);
  }

  if (entityWords.length >= 3) {
    return entityWords.slice(0, 6).join(" ");
  }

  if (nonStopWords.length >= 2) {
    return nonStopWords.slice(0, 5).join(" ");
  }

  return rawWords.slice(0, 5).join(" ");
}

function scoreCandidateRelevance(candidate, tokens, claimText) {
  if (!tokens || tokens.length === 0) return 0;
  const title = (candidate.title || "").toLowerCase();
  const snippet = (candidate.snippet || "").toLowerCase();
  const domain = (candidate.domain || "").toLowerCase();
  const publisher = (candidate.publisher || "").toLowerCase();
  const target = `${title} ${snippet} ${domain} ${publisher}`;
  let score = 0;
  let matches = 0;

  for (const token of tokens) {
    if (target.includes(token)) {
      matches += 1;
      if (title.includes(token)) score += 3;
      else if (snippet.includes(token)) score += 1.5;
      else score += 1;
    }
  }

  const cleanClaim = (claimText || "").trim().toLowerCase();
  if (cleanClaim.length > 5 && target.includes(cleanClaim)) {
    score += 5;
  }

  // Priority boost for Primary and Official Government Sources
  if (candidate.type === "Official Government Source") score += 2.5;
  else if (candidate.type === "Primary Source" || candidate.isPrimary) score += 2;
  else if (candidate.type === "Reputable News Source") score += 1.0;
  else if (candidate.type === "Public Reference") score += 0.8;

  if (matches === 0) return 0;
  return score;
}

function filterAndRankCandidates(candidates, claim, max = 5) {
  const tokens = getClaimTokens(claim);
  const scored = [];
  for (const c of candidates) {
    const score = scoreCandidateRelevance(c, tokens, claim);
    if (score > 0) {
      scored.push({ ...c, _score: score });
    }
  }

  if (scored.length === 0) return [];

  // Sort by relevance score descending
  scored.sort((a, b) => b._score - a._score);

  // Group by domain to keep only the single most relevant candidate from each domain
  const bestByDomain = new Map();
  for (const item of scored) {
    const d = (item.domain || "").toLowerCase().replace(/^www\./, "");
    if (!bestByDomain.has(d)) {
      bestByDomain.set(d, item);
    }
  }

  const deduplicated = Array.from(bestByDomain.values());

  // Prioritize source diversity when appropriate:
  // - Primary / Official Government Source
  // - Reputable Secondary / News Source
  // - Relevant Public Reference
  // - Verified Web Resource
  const primaries = deduplicated.filter(c => c.type === "Official Government Source" || c.type === "Primary Source" || c.isPrimary);
  const news = deduplicated.filter(c => c.type === "Reputable News Source");
  const references = deduplicated.filter(c => c.type === "Public Reference");

  const selected = [];
  const selectedDomains = new Set();

  const tryAdd = (item) => {
    if (selected.length >= max) return;
    const d = (item.domain || "").toLowerCase().replace(/^www\./, "");
    if (!selectedDomains.has(d)) {
      selectedDomains.add(d);
      selected.push(item);
    }
  };

  // 1. Pick top primary / official sources (up to 2)
  for (const c of primaries.slice(0, 2)) tryAdd(c);
  // 2. Pick top reputable news sources (up to 2)
  for (const c of news.slice(0, 2)) tryAdd(c);
  // 3. Pick top public references (up to 2)
  for (const c of references.slice(0, 2)) tryAdd(c);
  // 4. Fill remaining slots with next best overall candidates if available
  for (const c of deduplicated) {
    if (selected.length >= max) break;
    tryAdd(c);
  }

  // Do not force 5 sources: return only genuinely relevant candidates up to max
  return selected.slice(0, max).map(({ _score, ...rest }) => ({
    ...rest,
    type: normalizeSourceType(rest.type)
  }));
}

async function searchDuckDuckGo(query) {
  const endpoints = [
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
    'https://duckduckgo.com/html/?q=' + encodeURIComponent(query)
  ];
  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const $ = load(html);
      const results = [];
      $('.result').each((i, elem) => {
        const a = $(elem).find('.result__title a');
        const title = a.text().trim();
        let link = a.attr('href') || '';
        const snippet = $(elem).find('.result__snippet').text().trim();
        if (link.includes('uddg=')) {
          const m = link.match(/uddg=([^&]+)/);
          if (m) link = decodeURIComponent(m[1]);
        }
        if (title && link.startsWith('http') && !link.includes('duckduckgo.com')) {
          try {
            const parsed = new URL(link);
            const domain = parsed.hostname.replace(/^www\./, '').toLowerCase();
            results.push({
              title,
              url: cleanSourceUrl(link),
              domain,
              snippet
            });
          } catch {}
        }
      });
      if (results.length > 0) return results;
    } catch {
      // try next endpoint if timeout or error
    } finally {
      clearTimeout(timer);
    }
  }

  // Cloud-safe fallback: If HTML endpoints fail or return empty (e.g. datacenter IP challenge),
  // query DuckDuckGo's public Instant Answer REST API
  try {
    const apiUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const apiRes = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'FACTSIFT-AI-FactChecker/2.0' }
      });
      if (apiRes.ok) {
        const d = await apiRes.json();
        const apiResults = [];
        if (d.AbstractURL && d.AbstractText) {
          try {
            const parsed = new URL(d.AbstractURL);
            apiResults.push({
              title: d.Heading ? `${d.Heading} - ${d.AbstractSource || 'Reference'}` : 'Reference',
              url: cleanSourceUrl(d.AbstractURL),
              domain: parsed.hostname.replace(/^www\./, '').toLowerCase(),
              snippet: d.AbstractText
            });
          } catch {}
        }
        if (apiResults.length > 0) return apiResults;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {}

  return [];
}

async function searchWikipedia(query) {
  const cleanQ = (query || "").trim();
  if (!cleanQ) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // Wikipedia Full-Text Search API: searches article content and titles reliably on all networks
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQ)}&utf8=&format=json&srlimit=5`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FACTSIFT-AI-FactChecker/2.0' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results = [];
    for (const s of (data.query?.search || [])) {
      if (!s.title) continue;
      const cleanTitle = s.title;
      results.push({
        title: `${cleanTitle} - Wikipedia`,
        url: cleanSourceUrl(`https://en.wikipedia.org/wiki/${encodeURIComponent(cleanTitle.replace(/ /g, '_'))}`),
        domain: 'en.wikipedia.org',
        snippet: (s.snippet || '').replace(/<[^>]+>/g, '').trim() || `Reference article on ${cleanTitle}`
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchWikipediaText(query) {
  return searchWikipedia(query);
}

async function searchGoogleNews(query) {
  const cleanQ = (query || "").trim();
  if (!cleanQ) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanQ)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = load(xml, { xmlMode: true });
    const results = [];
    $('item').each((i, elem) => {
      if (results.length >= 6) return false;
      const item = $(elem);
      const rawTitle = item.find('title').text().trim();
      const link = item.find('link').text().trim();
      const sourceEl = item.find('source');
      const sourceName = sourceEl.text().trim();
      const sourceUrl = sourceEl.attr('url') || '';
      const pubDate = item.find('pubDate').text().trim();
      const desc = item.find('description').text().replace(/<[^>]+>/g, '').trim();

      if (!rawTitle || !link) return;

      let domain = '';
      if (sourceUrl) {
        try {
          domain = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase();
        } catch {}
      }
      if (!domain && link) {
        try {
          domain = new URL(link).hostname.replace(/^www\./, '').toLowerCase();
        } catch {}
      }

      let cleanTitle = rawTitle;
      if (sourceName && cleanTitle.endsWith(` - ${sourceName}`)) {
        cleanTitle = cleanTitle.slice(0, -(sourceName.length + 3)).trim();
      }

      const snippet = desc && desc !== rawTitle
        ? desc
        : (pubDate ? `${cleanTitle} (Reported: ${pubDate})` : cleanTitle);

      results.push({
        title: cleanTitle,
        url: cleanSourceUrl(link),
        domain: domain || 'news.google.com',
        snippet
      });
    });
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAuthoritativeSources(claim, page, customQueries = []) {
  const cleanClaim = (claim || (page ? page.title : "")).trim();
  if (!cleanClaim && (!customQueries || customQueries.length === 0)) return [];

  const currentYear = new Date().getFullYear();
  const expandedClaim = cleanClaim
    .replace(/\bpm\b/gi, 'Prime Minister')
    .replace(/\bcm\b/gi, 'Chief Minister');
  const words = expandedClaim.split(/\s+/).filter(Boolean);
  const coreQuery = words.slice(0, 14).join(' ');
  const conciseQuery = extractCoreSearchQuery(expandedClaim);

  const searchPromises = [];
  if (coreQuery) {
    searchPromises.push(searchDuckDuckGo(coreQuery));
  }
  if (conciseQuery && conciseQuery.toLowerCase() !== coreQuery.toLowerCase()) {
    searchPromises.push(searchDuckDuckGo(conciseQuery));
  }

  // Cloud-safe Wikipedia full-text search with concise entity/topic query
  if (conciseQuery) {
    searchPromises.push(searchWikipedia(conciseQuery));
  }
  if (coreQuery && coreQuery.toLowerCase() !== conciseQuery.toLowerCase()) {
    searchPromises.push(searchWikipedia(coreQuery));
  }

  // Cloud-safe Google News RSS search (public, reliable on all datacenter/serverless IPs)
  if (conciseQuery) {
    searchPromises.push(searchGoogleNews(conciseQuery));
  }
  if (coreQuery && coreQuery.toLowerCase() !== conciseQuery.toLowerCase()) {
    searchPromises.push(searchGoogleNews(coreQuery));
  }

  // Execute custom queries provided (e.g. from image OCR / claim extraction)
  if (Array.isArray(customQueries) && customQueries.length > 0) {
    for (const q of customQueries.slice(0, 4)) {
      const cleanQ = (q || '').trim();
      if (cleanQ && cleanQ.length > 3 && cleanQ.toLowerCase() !== coreQuery.toLowerCase()) {
        searchPromises.push(searchDuckDuckGo(cleanQ));
        const customConcise = extractCoreSearchQuery(cleanQ);
        if (customConcise && customConcise.toLowerCase() !== conciseQuery.toLowerCase()) {
          searchPromises.push(searchWikipedia(customConcise));
          searchPromises.push(searchGoogleNews(customConcise));
        }
      }
    }
  }

  // Targeted authority expansion based on topic category
  const isOfficeholderOrGov = /(?:prime minister|\bpm\b|president|minister|chief minister|\bcm\b|governor|court|law|election|parliament|govt|government)/i.test(expandedClaim) || /(?:prime minister|\bpm\b|president|minister|chief minister|\bcm\b|governor|court|law|election|parliament|govt|government)/i.test(cleanClaim);

  if (isOfficeholderOrGov) {
    const entityMatch = expandedClaim.match(/(?:prime minister|president|chief minister|governor)\s+(?:of\s+)?([a-z\s]+)/i);
    const target = entityMatch ? entityMatch[0].trim() : 'official government';
    searchPromises.push(searchDuckDuckGo(`current ${target} ${currentYear}`));
    searchPromises.push(searchDuckDuckGo(`${target} official website`));
    searchPromises.push(searchDuckDuckGo(`${coreQuery} ${currentYear}`));
    searchPromises.push(searchWikipedia(target));
    searchPromises.push(searchWikipediaText(`current ${target} ${currentYear}`));
    searchPromises.push(searchGoogleNews(`current ${target} ${currentYear}`));
  } else if (/(?:nasa|space|jwst|telescope|planet|exoplanet|trappist|mars|moon|galaxy|astronomy)/i.test(expandedClaim)) {
    searchPromises.push(searchDuckDuckGo(`${coreQuery} NASA official`));
    const scienceMatch = expandedClaim.match(/(?:trappist-[0-9a-z]+|jwst|james webb|mars|moon|voyager)/i);
    if (scienceMatch) {
      searchPromises.push(searchWikipedia(scienceMatch[0]));
      searchPromises.push(searchWikipediaText(`${scienceMatch[0]} atmosphere discovery`));
      searchPromises.push(searchGoogleNews(`${scienceMatch[0]} discovery`));
    } else {
      searchPromises.push(searchGoogleNews(`${conciseQuery || coreQuery} NASA`));
    }
  } else if (/(?:who|cdc|disease|vaccine|virus|health|fda|medical)/i.test(expandedClaim)) {
    searchPromises.push(searchDuckDuckGo(`${coreQuery} WHO CDC official health`));
    searchPromises.push(searchGoogleNews(`${conciseQuery || coreQuery} health`));
  } else if (/(?:fia|f1|formula\s*1|grand\s*prix|fifa|olympic|world\s*cup|tournament|championship|reschedul|relocat|venue|calendar|schedule)/i.test(expandedClaim)) {
    searchPromises.push(searchDuckDuckGo(`${coreQuery} official announcement`));
    searchPromises.push(searchDuckDuckGo(`${coreQuery} ${currentYear}`));
    searchPromises.push(searchDuckDuckGo(`${coreQuery} confirmed`));
    if (conciseQuery) {
      searchPromises.push(searchDuckDuckGo(`${conciseQuery} official`));
      searchPromises.push(searchWikipedia(conciseQuery));
      searchPromises.push(searchGoogleNews(conciseQuery));
    }
  }

  // Generic announcement/statement expansion
  if (coreQuery && /(?:statement|announc|official|confirm|held in|moved to|postpon|cancel|reschedul)/i.test(expandedClaim)) {
    searchPromises.push(searchDuckDuckGo(`${coreQuery} official statement`));
    searchPromises.push(searchGoogleNews(`${coreQuery} statement`));
  }

  const results = await Promise.all(searchPromises);
  const flattened = results.flat();

  // Deduplicate candidates by clean URL
  const seenUrls = new Set();
  const candidates = [];

  for (const item of flattened) {
    if (!item.url || seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    const meta = classifyDomain(item.domain);
    candidates.push({
      title: item.title,
      url: item.url,
      domain: meta.domain,
      publisher: meta.publisher,
      type: meta.type,
      isPrimary: meta.isPrimary,
      snippet: item.snippet
    });
  }

  return candidates;
}

// OCR & Claim Identification Module for Visual/Document Claims
async function extractImageClaimAndQueries({ image, userClaim, apiKey, model, baseUrl }) {
  if (!image || !apiKey) {
    return { transcription: "", claim: userClaim || "", queries: [] };
  }

  const prompt = `You are an expert OCR, document inspection, and factual claim extraction system.
Analyze the provided image carefully.

Tasks:
1. Extract and transcribe all relevant visible text, document titles, logos, organization names, dates, locations, and statements shown in the image.
2. Identify and state the core factual statement, announcement, claim, or allegation asserted in the image.
   CRITICAL RULES FOR CORE_CLAIM:
   - Extract ONLY the substantive factual claim, statement, announcement, or allegation contained in the image.
   - Write the claim directly and neutrally as the asserted proposition (e.g., "The FIA announced that during the Bahrain Grand Prix in Malaysia at the Sepang Circuit, low engine speed, wet-weather settings, and sector configurations caused a power loss, followed by a software update during a rain delay.").
   - NEVER evaluate, verify, judge, or fact-check the claim during extraction. CORE_CLAIM must represent the hypothesis being tested by FACTSIFT, not the result of the test.
   - NEVER add evaluative words, labels, conclusions, or verdict words such as: fake, satirical, parody, fabricated, hoax, misleading, false, genuine, authentic, verified, or debunked.
   - NEVER use media or container framing such as "The image presents...", "The image shows a fake...", "This screenshot claims...", "The post appears to...", or "The document is authentic/fake...". State the asserted statement directly.
   - Do NOT add conclusions, skepticism, credibility judgments, or fact-checking results.
   - Preserve important factual details from the image, including: people/organizations, dates, locations, event names, numbers, technical details, stated causes/effects, and actions or announcements.
   - If the image contains an unusual or apparently contradictory detail, DO NOT correct, reinterpret, or rationalize it. Preserve what the image asserts and let the later verification stage determine whether it is true or false.
3. If user added contextual text ("${userClaim || ""}"), factor it in to identify the relevant statement.
4. Generate 2 to 3 concise, highly effective live web search queries to verify whether this claim or statement is authentic, officially confirmed, reported by reputable media, or debunked. Include relevant years, locations, and official organization names. Generating search queries must NOT cause CORE_CLAIM to contain a verdict.

Respond in EXACTLY this format:
TRANSCRIPTION: [verbatim or summarized text from image]
CORE_CLAIM: [clear, neutral 1-2 sentence statement of the factual claim made in the image]
SEARCH_QUERIES: [query 1 | query 2 | query 3]`;

  try {
    const result = await callGeminiWithFallback({
      apiKey,
      primaryModel: model,
      systemPrompt: "You are an accurate OCR transcription and factual claim identification module for fact-checking images.",
      userPrompt: prompt,
      image,
      baseUrl,
      timeoutMs: 16_000
    });

    const text = result.text || "";
    const transcriptionMatch = text.match(/TRANSCRIPTION:\s*([\s\S]*?)(?=\n(?:CORE_CLAIM|SEARCH_QUERIES):|$)/i);
    const claimMatch = text.match(/CORE_CLAIM:\s*([\s\S]*?)(?=\nSEARCH_QUERIES:|$)/i);
    const queriesMatch = text.match(/SEARCH_QUERIES:\s*([^\n]+)/i);

    const transcription = transcriptionMatch ? transcriptionMatch[1].trim() : "";
    const extractedClaim = claimMatch ? claimMatch[1].trim() : "";
    const queriesStr = queriesMatch ? queriesMatch[1].trim() : "";
    const queries = queriesStr ? queriesStr.split("|").map(q => q.trim()).filter(q => q.length > 3) : [];

    return {
      transcription,
      claim: extractedClaim || userClaim || transcription,
      queries
    };
  } catch (err) {
    console.warn("[Image OCR/Extraction Notice]", err.message);
    return {
      transcription: "",
      claim: userClaim || "",
      queries: []
    };
  }
}

// Intelligent FACTSIFT AI Fact-Checking Engine (Google Gemini + Dynamic Live Sources)
async function performVerification({ claim, cleanUrl, page, image, userKey, userModel, userBaseUrl }) {
  const activeKey = (userKey || settingsState.apiKey || "").trim();
  const activeModel = normalizeModel(userModel || settingsState.model);
  const activeBaseUrl = (userBaseUrl || settingsState.baseUrl || "").trim();

  let effectiveClaim = (claim || (page ? page.title : "")).trim();
  let imageExtractedText = "";
  let imageSearchQueries = [];

  // 1. When an image is provided, extract its text, factual claims, and search queries first
  if (image && activeKey) {
    try {
      const extracted = await extractImageClaimAndQueries({
        image,
        userClaim: claim,
        apiKey: activeKey,
        model: activeModel,
        baseUrl: activeBaseUrl
      });
      imageExtractedText = extracted.transcription || "";
      if (extracted.claim && (!claim || claim.trim().length === 0)) {
        effectiveClaim = extracted.claim;
      }
      imageSearchQueries = extracted.queries || [];
    } catch (extractErr) {
      console.warn("[Image Extraction Error]", extractErr.message);
    }
  }

  // 2. Fetch real, non-fabricated candidate sources via live search
  const candidates = await fetchAuthoritativeSources(effectiveClaim, page, imageSearchQueries);

  // If the quota was recently found exhausted and user hasn't provided a custom key, use synthesis directly
  if (!userKey && Date.now() < quotaExhaustedUntil) {
    return synthesizeVerityFactCheck({
      claim: effectiveClaim,
      page,
      reason: "Google Gemini API quota balance is exhausted (429).",
      warning: "Live AI verification is temporarily unavailable due to upstream API rate limits (429). Please retry shortly or configure your Gemini API key in Settings (⚙).",
      candidates
    });
  }

  const now = new Date();
  const currentDateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const currentYear = now.getFullYear();

  // Build live search grounding context for the AI
  const searchContext = candidates.slice(0, 10).map((c, idx) =>
    `[Source ${idx + 1}] Title: ${c.title}\nPublisher: ${c.publisher}\nDomain: ${c.domain}\nType: ${c.type}\nURL: ${c.url}\nExcerpt: ${c.snippet}`
  ).join('\n\n');

  const prompt = `You are FACTSIFT AI, an elite objective, evidence-based fact-checking engine designed to produce authoritative factual verification.
CURRENT SYSTEM DATE: ${currentDateStr} (Year: ${currentYear})

LIVE EVIDENCE & TEMPORAL REASONING PRINCIPLES:
- For current, scheduled, rescheduled, relocated, or time-sensitive events, ALWAYS prioritize fresh live web evidence over pre-trained general knowledge or assumptions.
- Do NOT reject or mark a claim FALSE simply because it conflicts with common sense, traditional knowledge, or historical precedent (such as an event traditionally held in one country being relocated or hosted in another country, unexpected calendar changes, or unprecedented decisions). Events change, venues relocate, and exceptions happen.
- When live web evidence contradicts your initial assumption or pre-trained knowledge, LIVE EVIDENCE MUST TAKE ABSOLUTE PRIORITY.
- Prefer authoritative primary sources:
  * Official government websites (.gov, official portals)
  * Official organizations and governing bodies (e.g. sports federations like FIA/Formula 1, FIFA, IOC; science bodies like NASA, ESA; international bodies like UN, WHO, WTO)
  * Verified official statements, press releases, and reputable news wires
- Give greater weight to primary authorities and reputable news reporting. Do not ignore a source merely because another component of the claim is unsupported.

VERDICT STANDARDS & OPERATIONAL DEFINITIONS:
- TRUE: All core substantive factual assertions are supported by reliable evidence.
- FALSE: The primary/core claim is directly contradicted by reliable evidence, or the central factual premise is demonstrably false.
- MISLEADING: The claim combines genuine facts with false, exaggerated, unsupported, or out-of-context claims, OR connects a real event to an unsupported cause. Use MISLEADING when the overall statement creates a materially false impression even though some individual parts are true.
- UNCERTAIN: Reliable evidence is genuinely insufficient, conflicting, or inconclusive to determine whether the core claim is true or false. Do NOT use UNCERTAIN merely because one part of a compound claim is unsupported when other parts are clearly confirmed and the combination creates a misleading impression.

COMPOUND & MIXED CLAIM RULES:
- Before assigning the overall verdict, internally identify the distinct factual components of the claim (e.g., event/action, quantity or scope, location, stated cause, consequence, timing).
- Evaluate each component against the available live evidence.
- For causal claims, verify the cause separately from the event. A real event does NOT automatically prove the claimed cause.
- For mixed claims: If meaningful parts are confirmed but another important part is false, unsupported, exaggerated, or creates false context, prefer MISLEADING over UNCERTAIN when the available evidence supports that conclusion.
- CAUSAL & MECHANISM SPECIFICITY:
  * When a claim connects an event to a specific cause, trigger, or mechanism using words such as "after", "because", "due to", "following", "caused by", or "as a result of", verify BOTH the event AND the specific asserted cause/mechanism separately.
  * Do NOT assign TRUE merely because the underlying event is real.
  * The exact asserted cause, mechanism, pathogen/agent, and causal relationship must be supported by reliable evidence when they materially affect the meaning of the claim.
  * Never substitute a related event for the specific asserted cause (for example, evidence that a laboratory worker became ill or died does NOT prove that a deadly virus leaked from a laboratory; evidence of a routine power trip does not prove a cyberattack).
  * If the underlying event is confirmed but the specific asserted cause/mechanism is false, unsupported, exaggerated, or materially different from what sources report, assign MISLEADING rather than TRUE.
  * Distinguish temporal sequence from causation. A source saying event B happened "after" event A does not by itself prove that A caused B.
  * For causal claims, require evidence supporting the actual causal mechanism stated in the claim, not merely evidence that related events occurred near each other in time.
- In EXPLANATION:
  * Clearly state which important components are confirmed.
  * Clearly state which are contradicted, exaggerated, or unverified.
  * Do NOT make blanket statements that dismiss the entire claim when reliable evidence confirms part of it.
  * Do NOT claim that something did not happen merely because no source was found; distinguish "not confirmed" from "confirmed false".
- Confidence calibration:
  * Confidence should reflect the evidence for the OVERALL verdict.
  * Do not assign very high confidence when important components remain genuinely unresolved.
  * If reliable live sources are absent or inconclusive, assign UNCERTAIN with lower confidence.

Analyse the submitted claim, context, and/or webpage using verified empirical facts, current temporal context, and the LIVE WEB SEARCH FINDINGS below.

CLAIM TO VERIFY:
${effectiveClaim || (page ? `Article: ${page.title}` : "Visual image statement verification")}

${imageExtractedText ? `EXTRACTED IMAGE CONTENT / OCR:\n${imageExtractedText}\n` : ""}
${page ? `WEBSITE CONTEXT:\nURL: ${page.url}\nDomain: ${page.domain}\nReadable Excerpt:\n${page.text.slice(0, 8000)}` : ""}

LIVE WEB SEARCH FINDINGS:
${searchContext || "No live external search results available."}

INSTRUCTIONS:
1. Determine the VERDICT: TRUE, FALSE, MISLEADING, or UNCERTAIN based strictly on the VERDICT STANDARDS above.
2. Provide CONFIDENCE: 0-100%. Reflect evidence strength for the overall verdict; do not use very high confidence when important components remain genuinely unresolved.
3. In EXPLANATION: A concise, highly balanced analytical breakdown explaining why the claim is true, false, misleading, or unproven relative to today's date (${currentDateStr}).
   - For compound claims, clearly distinguish what is confirmed from what is exaggerated, unverified, or contradicted.
   - For political or government-related claims, remain strictly factual, neutral, and impartial. Do not introduce political opinions. Do not rank politicians, parties, candidates, or political choices.
   - When official sources, governing bodies, or reputable news document an exceptional event, relocation, or change, rely strictly on verified current facts.
   - If pre-trained knowledge contradicts recent live web findings, ALWAYS prioritize the up-to-date live search findings.
4. In EVIDENCE: The concrete facts, dates, timelines, and official statements that prove, disprove, or qualify the statement and its components.
5. In SELECTED_SOURCES: Select up to 5 source numbers (e.g. 1, 3) from the LIVE WEB SEARCH FINDINGS above that directly support, contradict, or provide necessary context for the claim.
   - Prioritize directly relevant OFFICIAL GOVERNMENT SOURCES and PRIMARY SOURCES.
   - Use REPUTABLE NEWS SOURCES and PUBLIC REFERENCES when helpful for secondary context.
   - Avoid redundant duplicate sources from the same domain; select only the single most relevant page per domain.
   - DO NOT select weak, tangential, or unrelated sources just to reach 5 sources. If only 2 or 3 sources are relevant, select only those 2 or 3.
   - NEVER fabricate or invent URLs or titles not in the list. If none are relevant, output NONE.

Return your response in EXACTLY this format:
VERDICT: TRUE, FALSE, MISLEADING, or UNCERTAIN
CONFIDENCE: 0-100%
EXPLANATION: [concise, neutral, factual analysis]
EVIDENCE: [concrete facts and evidence]
SELECTED_SOURCES: [comma-separated numbers from the list above, e.g. 1, 2, 4 or NONE]`;

  if (activeKey) {
    try {
      const systemInstruction = `You are FACTSIFT AI, an elite factual verification system dedicated to neutrality, accuracy, primary evidence, and temporal precision.
CURRENT SYSTEM DATE: ${currentDateStr} (Year: ${currentYear}).
CORE VERIFICATION RULES:
1. Evaluate all claims as of today: ${currentDateStr}.
2. Prioritize fresh, verified live web evidence over older pre-trained model knowledge.
3. Do NOT reject claims simply because they conflict with historical norms or general knowledge (e.g. rescheduled, relocated, or exceptional events).
4. Prefer authoritative primary sources (official government portals, official organizations like FIA/Formula 1, FIFA, IOC, NASA/ESA, WHO).
5. For compound or mixed claims, evaluate distinct components; assign MISLEADING when genuine facts are combined with false, exaggerated, or unverified claims.
6. If live search results conflict or if reliable current evidence is missing, do not guess with high confidence; explain the uncertainty.
7. Calibrate confidence carefully: do not assign 100% confidence to image claims unless definitive primary sources prove it.`;

      const geminiResult = await callGeminiWithFallback({
        apiKey: activeKey,
        primaryModel: activeModel,
        systemPrompt: systemInstruction,
        userPrompt: prompt,
        image,
        baseUrl: activeBaseUrl,
        timeoutMs: GEMINI_TIMEOUT_MS
      });

      const analysisText = geminiResult.text || "";
      const parsed = parseAnalysis(analysisText);

      // Extract selected sources from model output
      const selMatch = analysisText.match(/SELECTED_SOURCES:\s*([^\n]+)/i);
      const selStr = selMatch ? selMatch[1].trim() : "";
      const indices = (selStr.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= candidates.length);

      let finalSources = [];
      const seenDomains = new Set();

      // If page was submitted by user, include it as primary subject source
      if (page) {
        const pageDomain = (page.domain || "").toLowerCase().replace(/^www\./, "");
        seenDomains.add(pageDomain);
        finalSources.push({
          title: page.title,
          url: page.url,
          domain: page.domain,
          publisher: classifyDomain(page.domain).publisher,
          type: "Submitted Page"
        });
      }

      // Add AI-selected sources (avoiding duplicate domains)
      for (const idx of indices) {
        const c = candidates[idx - 1];
        if (c) {
          const d = (c.domain || "").toLowerCase().replace(/^www\./, "");
          if (!seenDomains.has(d) && !finalSources.some(s => s.url === c.url)) {
            seenDomains.add(d);
            finalSources.push({
              title: c.title,
              url: c.url,
              publisher: c.publisher,
              domain: c.domain,
              type: normalizeSourceType(c.type)
            });
          }
        }
      }

      // If AI didn't select any sources, select only genuinely relevant candidates (NO artificial padding!)
      if (finalSources.length === (page ? 1 : 0) && candidates.length > 0) {
        const maxSlots = 5 - finalSources.length;
        const ranked = filterAndRankCandidates(candidates, effectiveClaim, maxSlots);
        for (const c of ranked) {
          const d = (c.domain || "").toLowerCase().replace(/^www\./, "");
          if (!seenDomains.has(d) && !finalSources.some(s => s.url === c.url)) {
            seenDomains.add(d);
            finalSources.push({
              title: c.title,
              url: c.url,
              publisher: c.publisher,
              domain: c.domain,
              type: normalizeSourceType(c.type)
            });
          }
        }
      }

      // Limit to maximum 5 sources
      finalSources = finalSources.slice(0, 5);

      // Calibrate confidence for current officeholder claims when reliable current evidence is missing or conflicting
      const isOfficeholderClaim = /(?:chief minister|\bcm\b|prime minister|\bpm\b|president|governor|minister of)\b/i.test(effectiveClaim || "");
      if (isOfficeholderClaim) {
        if (candidates.length === 0 && parsed.confidence >= 80) {
          parsed.confidence = 70;
        } else if (parsed.verdict === "UNCERTAIN" && parsed.confidence > 60) {
          parsed.confidence = 50;
        } else if (parsed.confidence === 100) {
          const hasOfficialGov = finalSources.some(s => s.type === "Official Government Source" || s.type === "Primary Source" || s.isPrimary);
          if (!hasOfficialGov) {
            parsed.confidence = 95;
          }
        }
      }

      // Requirement 7 & 8: Check whether genuine live web sources were retrieved
      const hasLiveSources = finalSources.length > 0;

      // Calibrate confidence for image claims: only calibrate when genuine live sources are present but non-primary
      if (image && parsed.confidence === 100 && hasLiveSources) {
        const hasAuthoritativeSource = finalSources.some(s => s.type === "Official Government Source" || s.type === "Primary Source" || s.isPrimary);
        if (!hasAuthoritativeSource) {
          parsed.confidence = 90;
        }
      }

      if (!hasLiveSources) {
        if (parsed.evidence && /corroborated by live web|verified via live search|live web search confirmed/i.test(parsed.evidence)) {
          parsed.evidence = "No external web sources could be retrieved to substantiate this claim. Evaluated using model internal knowledge.";
        }
        return {
          claim: effectiveClaim,
          analysis: analysisText,
          ...parsed,
          verdict: (parsed.verdict === "FALSE" && !hasLiveSources) ? "UNCERTAIN" : parsed.verdict,
          confidence: Math.min(parsed.confidence, 50),
          sources: [],
          engine: "Google Gemini Engine • Model Knowledge (Live Sources Unavailable)",
          modelUsed: geminiResult.modelUsed || activeModel,
          verificationMode: "knowledge_fallback",
          warning: "Live web verification was unavailable or insufficient: no live web sources could be retrieved for this claim. This assessment relies on pre-trained model knowledge and may not reflect recent or rescheduled events."
        };
      }

      return {
        claim: effectiveClaim,
        analysis: analysisText,
        ...parsed,
        sources: finalSources,
        engine: "Google Gemini Engine • Live Web Verification",
        modelUsed: geminiResult.modelUsed || activeModel,
        verificationMode: "live_web",
        warning: null
      };
    } catch (apiError) {
      console.warn("[Gemini API Notice]", apiError.message);
      if (apiError.status === 429 || apiError.geminiError?.status === "RESOURCE_EXHAUSTED") {
        if (!userKey) {
          quotaExhaustedUntil = Date.now() + 15 * 1000;
        }
        return synthesizeVerityFactCheck({
          claim: effectiveClaim,
          page,
          reason: "Google Gemini API quota balance is exhausted (429).",
          warning: "Live AI verification is temporarily unavailable due to upstream API rate limits (429). Please retry shortly or configure your Gemini API key in Settings (⚙).",
          candidates
        });
      }
      if (apiError.status === 401 || (apiError.status === 400 && apiError.message.includes("API key not valid"))) {
        return synthesizeVerityFactCheck({
          claim: effectiveClaim,
          page,
          reason: "Google Gemini API authentication failed.",
          warning: "The Gemini API key was rejected by Google. Please update your API key in Settings (⚙).",
          candidates
        });
      }
      return synthesizeVerityFactCheck({
        claim: effectiveClaim,
        page,
        reason: apiError.message,
        warning: `Google Gemini API notice: ${apiError.message}. Live verification is temporarily unavailable. Please retry shortly.`,
        candidates
      });
    }
  }

  // If no API key configured, use FACTSIFT AI dynamic verification
  return synthesizeVerityFactCheck({
    claim: effectiveClaim,
    page,
    reason: "No API Key configured on server.",
    warning: "No active Gemini API key configured on server. Add your Gemini API key in Settings (⚙) for real-time live web verification.",
    candidates
  });
}

// Built-in FACTSIFT AI fact verification synthesis for high availability & stability
function synthesizeVerityFactCheck({ claim, page, reason, warning, candidates = [] }) {
  let verdict = "UNCERTAIN";
  let confidence = 50;
  let explanation = "";
  let evidence = "";
  let sources = [];
  const seenDomains = new Set();

  if (page) {
    verdict = "UNCERTAIN";
    confidence = 50;
    explanation = "Live AI verification is temporarily unavailable due to an upstream Gemini API rate limit or service issue. FACTSIFT could not verify this webpage at this time. Please retry shortly.";
    evidence = `Reachable webpage at ${page.domain}. Extracted ${page.text.length} characters of readable context. Automated verification was paused because the AI provider was unavailable. No factual judgment was rendered.`;
    const pageDomain = (page.domain || "").toLowerCase().replace(/^www\./, "");
    seenDomains.add(pageDomain);
    sources.push({
      title: page.title,
      url: page.url,
      domain: page.domain,
      publisher: classifyDomain(page.domain).publisher,
      type: "Submitted Page"
    });
  }

  // Filter candidates strictly by relevance to claim with domain deduplication - NO artificial padding
  if (candidates && candidates.length > 0) {
    const maxSlots = 5 - sources.length;
    const relevant = filterAndRankCandidates(candidates, claim, maxSlots);
    for (const c of relevant) {
      const d = (c.domain || "").toLowerCase().replace(/^www\./, "");
      if (!seenDomains.has(d) && !sources.some(s => s.url === c.url)) {
        seenDomains.add(d);
        sources.push({
          title: c.title,
          url: c.url,
          publisher: c.publisher,
          domain: c.domain,
          type: normalizeSourceType(c.type)
        });
      }
    }
  }

  if (!explanation) {
    explanation = "Live AI verification is temporarily unavailable due to an upstream Gemini API rate limit or service issue. FACTSIFT could not verify this claim at this time. Please retry shortly.";
  }
  if (!evidence) {
    evidence = sources.length > 0
      ? `Automated verification was paused because the AI provider was unavailable. Referenced ${sources.length} background web sources, but no factual judgment was rendered.`
      : "Automated verification was paused because the AI provider was unavailable. No factual judgment was rendered.";
  }

  sources = sources.slice(0, 5);

  return {
    verdict,
    confidence,
    explanation,
    evidence,
    sources,
    engine: "FACTSIFT AI Fallback Engine (Service Temporarily Unavailable)",
    verificationMode: "knowledge_fallback",
    warning: warning || "Live AI verification is temporarily unavailable due to an upstream Gemini API rate limit or service issue. Please retry shortly."
  };
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Serve frontend static assets (FACTSIFT AI UI)
app.use(express.static(path.join(__dirname, "../frontend")));

// Root & Health
app.get("/", (req, res) => {
  if (req.accepts("html") && !req.accepts("json")) {
    return res.sendFile(path.join(__dirname, "../frontend/index.html"));
  }
  res.json({
    status: "ok",
    app: "FACTSIFT AI Fact Checker Engine",
    version: "2.0.0",
    hasApiKey: !!settingsState.apiKey,
    activeModel: settingsState.model
  });
});

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// Settings API: Read active settings
app.get("/api/settings", (req, res) => {
  res.json({
    hasApiKey: !!settingsState.apiKey,
    maskedApiKey: maskKey(settingsState.apiKey),
    model: settingsState.model,
    baseUrl: settingsState.baseUrl,
    rateLimitMax: settingsState.rateLimitMax,
    searchDepth: settingsState.searchDepth,
    provider: "gemini",
    availableModels: [
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (Ultra-Fast & Accurate)", recommended: true },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite (High Efficiency)", recommended: false },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview (Next-Gen)", recommended: false },
      { id: "gemini-flash-latest", name: "Gemini Flash Latest", recommended: false },
      { id: "gemini-pro-latest", name: "Gemini Pro Latest", recommended: false }
    ],
    serverTime: new Date().toISOString()
  });
});

// Dedicated Rate Limiter for Settings Test endpoint (anti-abuse)
const testLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many connection test requests. Please wait a few moments before testing again." }
});

// Settings API: Update settings
app.post("/api/settings", (req, res) => {
  const { apiKey, model, baseUrl, rateLimitMax, searchDepth } = req.body || {};

  if (typeof apiKey === "string") {
    const clean = apiKey.replace(/[\r\n\t]/g, "").trim();
    if (clean && clean.length <= 256 && /^[a-zA-Z0-9_\-\.]+$/.test(clean)) {
      settingsState.apiKey = clean;
      quotaExhaustedUntil = 0; // reset exhaustion cache
    }
  }
  if (typeof model === "string") {
    const clean = model.replace(/[\r\n\t]/g, "").trim();
    if (clean && clean.length <= 64 && /^[a-zA-Z0-9_\-\.]+$/.test(clean)) {
      settingsState.model = normalizeModel(clean);
      quotaExhaustedUntil = 0;
    }
  }
  if (baseUrl !== undefined) {
    const clean = typeof baseUrl === "string" ? baseUrl.replace(/[\r\n\t]/g, "").trim() : "";
    if (!clean || (clean.length <= 512 && /^https?:\/\//i.test(clean))) {
      settingsState.baseUrl = getEffectiveBaseUrl(clean);
      quotaExhaustedUntil = 0;
    }
  }
  if (rateLimitMax !== undefined) {
    const r = Number(rateLimitMax);
    if (Number.isInteger(r) && r >= 5 && r <= 1000) {
      settingsState.rateLimitMax = r;
    }
  }
  if (searchDepth && ["fast", "balanced", "deep"].includes(searchDepth)) {
    settingsState.searchDepth = searchDepth;
  }

  // Persist to backend/.env if permitted (strictly CRLF-sanitized)
  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = "";
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }
    const updateEnvVar = (content, key, val) => {
      const sanitizedVal = String(val).replace(/[\r\n]/g, "").trim();
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(content)) return content.replace(regex, `${key}=${sanitizedVal}`);
      return `${content.trim()}\n${key}=${sanitizedVal}\n`;
    };
    if (settingsState.apiKey) envContent = updateEnvVar(envContent, "GEMINI_API_KEY", settingsState.apiKey);
    if (settingsState.model) envContent = updateEnvVar(envContent, "GEMINI_MODEL", settingsState.model);
    if (settingsState.baseUrl) envContent = updateEnvVar(envContent, "GEMINI_BASE_URL", settingsState.baseUrl);
    fs.writeFileSync(envPath, envContent, "utf8");
  } catch (err) {
    console.warn("[WARN] Could not write to .env file:", err.message);
  }

  res.json({
    success: true,
    message: "Settings saved successfully",
    settings: {
      hasApiKey: !!settingsState.apiKey,
      maskedApiKey: maskKey(settingsState.apiKey),
      model: settingsState.model,
      baseUrl: settingsState.baseUrl,
      rateLimitMax: settingsState.rateLimitMax,
      searchDepth: settingsState.searchDepth,
      provider: "gemini"
    }
  });
});

// Settings API: Test Connection (with abuse limiter)
app.post("/api/settings/test", testLimiter, async (req, res) => {
  const rawKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.replace(/[\r\n\t]/g, "").trim() : "";
  const keyToTest = (rawKey || settingsState.apiKey || "").trim();
  const rawBase = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.replace(/[\r\n\t]/g, "").trim() : "";
  const baseUrlToTest = (rawBase || settingsState.baseUrl || "").trim();

  if (!keyToTest) {
    return res.status(400).json({ success: false, message: "Please enter an API Key to test." });
  }

  const startTime = Date.now();
  try {
    const models = await listGeminiModels(keyToTest, baseUrlToTest, 10_000);
    const latency = Date.now() - startTime;
    return res.json({
      success: true,
      latencyMs: latency,
      message: `Connection successful! Verified ${models.length} models with Google Gemini in ${latency}ms.`
    });
  } catch (error) {
    const latency = Date.now() - startTime;
    const status = error.status || 500;
    let message = error.message;
    if (status === 429 || error.geminiError?.status === "RESOURCE_EXHAUSTED") {
      message = "Quota exhausted (429): Rate limit or quota limit reached on your Google Gemini API key.";
    } else if (status === 400 && error.message.includes("API key not valid")) {
      message = "Authentication error: Google Gemini API key is invalid or revoked.";
    } else if (status === 403 || error.geminiError?.status === "PERMISSION_DENIED") {
      message = "Permission denied: Google Gemini API is not enabled for this project or key lacks permission.";
    }
    return res.status(200).json({
      success: false,
      status,
      latencyMs: latency,
      message
    });
  }
});

// Main Fact-Check Verification Endpoint
app.post("/api/check", checkLimiter, async (req, res, next) => {
  try {
    const { claim, image, url, settings } = req.body || {};

    if (claim !== undefined && (typeof claim !== "string" || claim.length > 8000)) {
      throw fail("Text claim must be 8,000 characters or fewer.");
    }
    if (url !== undefined && (typeof url !== "string" || url.length > 2048)) {
      throw fail("Enter a valid website URL.");
    }
    validateImage(image);

    const cleanClaim = (claim || "").trim();
    const cleanUrl = (url || "").trim();

    if (!cleanClaim && !image && !cleanUrl) {
      throw fail("Please enter a claim, attach an image, or provide a website URL.");
    }

    const page = cleanUrl ? await fetchPage(cleanUrl) : null;
    if (page && !page.readable) {
      return res.json({
        claim: page.title,
        sourceUrl: page.url,
        page: { title: page.title, domain: page.domain },
        urlExtractionError: true,
        verdict: "UNCERTAIN",
        confidence: 0,
        explanation: "FACTSIFT AI could not extract sufficient readable article text from this webpage.",
        evidence: "The page may require a subscription, run heavy client-side scripts, or block automated readers. Try copying the claim text directly.",
        sources: [{ title: page.title, url: page.url, domain: page.domain, type: "Submitted Page" }],
        breakdown: [{ id: 1, text: page.title, verdict: "UNCERTAIN" }]
      });
    }

    // Read per-request setting overrides from headers or body
    const userKey = req.headers["x-api-key"] || settings?.apiKey;
    const userModel = req.headers["x-model"] || settings?.model;
    const userBaseUrl = req.headers["x-base-url"] || settings?.baseUrl;

    // Timeout safeguard: 35s max for entire verification operation to ensure UI never hangs
    const verificationPromise = performVerification({
      claim: cleanClaim,
      cleanUrl,
      page,
      image,
      userKey,
      userModel,
      userBaseUrl
    });

    let result;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error("Verification request timed out after 35s. Please try again."), { status: 504 })), 35_000);
      });
      result = await Promise.race([verificationPromise, timeoutPromise]);
    } catch (raceErr) {
      console.warn("[Verification Timeout/Error]", raceErr.message);
      result = synthesizeVerityFactCheck({
        claim: cleanClaim,
        page,
        reason: raceErr.message,
        warning: "Live verification took too long to complete. Live AI verification is temporarily unavailable. Please retry shortly."
      });
    }

    const primaryClaimText = cleanClaim || result.claim || (page ? page.title : "Image-based statement");

    res.json({
      claim: primaryClaimText,
      sourceUrl: page?.url || null,
      page: page ? { title: page.title, domain: page.domain } : null,
      verdict: result.verdict,
      confidence: result.confidence,
      explanation: result.explanation,
      evidence: result.evidence,
      sources: result.sources || [],
      engine: result.engine,
      verificationMode: result.verificationMode || "live_web",
      modelUsed: result.modelUsed || settingsState.model,
      warning: result.warning || null,
      timestamp: new Date().toISOString(),
      breakdown: [
        {
          id: 1,
          text: primaryClaimText,
          verdict: result.verdict,
          confidence: result.confidence
        }
      ]
    });
  } catch (error) {
    next(error);
  }
});

// Robust Error Handling Middleware
app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) {
    console.error("[SERVER ERROR]", error.message, error.stack);
  }
  res.status(status).json({
    error: error.expose ? error.message : "Unable to complete verification right now. Please check your settings or try again.",
    details: error.status === 429 ? "Quota limit reached" : undefined
  });
});

app.listen(PORT, () => {
  console.log(`\n=================================================`);
  console.log(`  FACTSIFT AI Fact-Checker API Server Active`);
  console.log(`  Listening on: http://localhost:${PORT}`);
  console.log(`  Settings & Health: http://localhost:${PORT}/api/settings`);
  console.log(`=================================================\n`);
});
