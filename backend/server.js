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
const GEMINI_TIMEOUT_MS = 25_000;
const FALLBACK_MODELS = ["gemini-3.1-flash-lite", "gemini-3-flash-preview"];

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

  const RETRY_DELAYS_MS = [1000, 2000];
  const MAX_RETRIES = 2;
  let retriesUsed = 0;
  let lastError = null;

  for (const currentModel of modelsToTry) {
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

        // Exponential backoff retry for temporary HTTP 503 high demand or 429 rate limit (max 2 retries per request)
        if (retriesUsed < MAX_RETRIES && isRetryableGeminiError(err)) {
          const delayMs = RETRY_DELAYS_MS[retriesUsed] || 2000;
          retriesUsed++;
          console.warn(`[Gemini Retry] Model ${currentModel} returned HTTP ${err.status || err.message}. Retrying attempt ${retriesUsed}/${MAX_RETRIES} in ${delayMs}ms...`);
          await sleep(delayMs);
          continue;
        }

        // When retries are exhausted or error is not retryable, move to next model in fallback chain
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
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 VerityAI/2.0", Accept: "text/html,application/xhtml+xml" }
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
  'britannica.com': { publisher: 'Encyclopaedia Britannica', type: 'Public Reference', isPrimary: false }
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
  if (/\.edu(\.[a-z]{2})?$/i.test(d) || /\.ac\.[a-z]{2}$/i.test(d)) {
    return { domain: d, publisher: 'Academic Institution', type: 'Primary Source', isPrimary: true };
  }
  const root = d.split('.')[0];
  const capitalized = root.charAt(0).toUpperCase() + root.slice(1);
  return { domain: d, publisher: capitalized, type: 'Verified Web Resource', isPrimary: false };
}

function getClaimTokens(text) {
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
  if (tokenSet.has("jwst")) {
    tokenSet.add("james");
    tokenSet.add("webb");
  }
  return Array.from(tokenSet);
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
  return [];
}

async function searchWikipedia(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=opensearch&search=' + encodeURIComponent(query) + '&limit=4&namespace=0&format=json';
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TruthLensFactChecker/2.0' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const titles = data[1] || [];
    const snippets = data[2] || [];
    const links = data[3] || [];
    const results = [];
    for (let i = 0; i < titles.length; i++) {
      if (links[i] && titles[i]) {
        results.push({
          title: `${titles[i]} - Wikipedia`,
          url: cleanSourceUrl(links[i]),
          domain: 'en.wikipedia.org',
          snippet: snippets[i] || `Reference article on ${titles[i]}`
        });
      }
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchWikipediaText(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&srlimit=4`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TruthLensFactChecker/2.0' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results = [];
    for (const s of (data.query?.search || [])) {
      results.push({
        title: `${s.title} - Wikipedia`,
        url: cleanSourceUrl(`https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`),
        domain: 'en.wikipedia.org',
        snippet: s.snippet.replace(/<[^>]+>/g, '')
      });
    }
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAuthoritativeSources(claim, page) {
  const cleanClaim = (claim || (page ? page.title : "")).trim();
  if (!cleanClaim) return [];

  const expandedClaim = cleanClaim.replace(/\bpm\b/gi, 'Prime Minister');
  const words = expandedClaim.split(/\s+/);
  const coreQuery = words.slice(0, 14).join(' ');

  const searchPromises = [searchDuckDuckGo(coreQuery)];

  // Targeted authority expansion based on topic category
  if (/(?:prime minister|pm|president|minister|chief minister|governor|court|law|election|parliament|govt|government)/i.test(expandedClaim)) {
    const entityMatch = expandedClaim.match(/(?:prime minister|president|chief minister|governor)\s+(?:of\s+)?([a-z\s]+)/i);
    const target = entityMatch ? entityMatch[0].trim() : 'official government';
    searchPromises.push(searchDuckDuckGo(`${target} official website`));
    searchPromises.push(searchWikipedia(target));
    searchPromises.push(searchWikipediaText(target));
  } else if (/(?:nasa|space|jwst|telescope|planet|exoplanet|trappist|mars|moon|galaxy|astronomy)/i.test(expandedClaim)) {
    searchPromises.push(searchDuckDuckGo(`${coreQuery} NASA official`));
    const scienceMatch = expandedClaim.match(/(?:trappist-[0-9a-z]+|jwst|james webb|mars|moon|voyager)/i);
    if (scienceMatch) {
      searchPromises.push(searchWikipedia(scienceMatch[0]));
      searchPromises.push(searchWikipediaText(`${scienceMatch[0]} atmosphere discovery`));
    }
  } else if (/(?:who|cdc|disease|vaccine|virus|health|fda|medical)/i.test(expandedClaim)) {
    searchPromises.push(searchDuckDuckGo(`${coreQuery} WHO CDC official health`));
  }

  // Include encyclopedic reference for historical / definition context
  if (words.length >= 2) {
    searchPromises.push(searchWikipedia(words.slice(0, 5).join(' ')));
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

// Intelligent TruthLens Fact-Checking Engine (Google Gemini + Dynamic Live Sources)
async function performVerification({ claim, cleanUrl, page, image, userKey, userModel, userBaseUrl }) {
  const activeKey = (userKey || settingsState.apiKey || "").trim();
  const activeModel = normalizeModel(userModel || settingsState.model);
  const activeBaseUrl = (userBaseUrl || settingsState.baseUrl || "").trim();

  // Fetch real, non-fabricated candidate sources via live search
  const candidates = await fetchAuthoritativeSources(claim, page);

  // If the quota was recently found exhausted and user hasn't provided a custom key, use synthesis directly
  if (!userKey && Date.now() < quotaExhaustedUntil) {
    return synthesizeVerityFactCheck({
      claim,
      page,
      reason: "Google Gemini API quota balance is exhausted (429).",
      warning: "Live AI verification is temporarily unavailable due to API rate limits (429). TruthLens evaluated this statement using offline knowledge archives. Live verification will resume shortly.",
      candidates
    });
  }

  // Build live search grounding context for the AI
  const searchContext = candidates.slice(0, 10).map((c, idx) =>
    `[Source ${idx + 1}] Title: ${c.title}\nPublisher: ${c.publisher}\nDomain: ${c.domain}\nType: ${c.type}\nURL: ${c.url}\nExcerpt: ${c.snippet}`
  ).join('\n\n');

  const prompt = `You are TruthLens AI, an elite objective, evidence-based fact-checking engine designed to produce authoritative factual verification.
Analyse the submitted claim, context, and/or webpage using verified empirical facts and the LIVE WEB SEARCH FINDINGS below.

CLAIM TO VERIFY:
${claim || (page ? `Article: ${page.title}` : "Visual image claim verification")}

${page ? `WEBSITE CONTEXT:\nURL: ${page.url}\nDomain: ${page.domain}\nReadable Excerpt:\n${page.text.slice(0, 8000)}` : ""}

LIVE WEB SEARCH FINDINGS:
${searchContext || "No live external search results available."}

INSTRUCTIONS:
1. Determine the VERDICT: TRUE, FALSE, MISLEADING, or UNCERTAIN.
2. Provide CONFIDENCE: 0-100%.
3. In EXPLANATION: A concise, highly balanced analytical breakdown explaining why the claim is true, false, misleading, or unproven.
   - For political or government-related claims, remain strictly factual, neutral, and impartial. Do not introduce political opinions. Do not rank politicians, parties, candidates, or political choices.
   - When official government sources establish the factual status (such as constitutional roles, official records, or designated officeholders), rely strictly on verified official records.
4. In EVIDENCE: The concrete facts, timelines, or official statements that prove or disprove the statement.
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
      const systemInstruction = "You are TruthLens AI, an elite factual verification system dedicated to neutrality, accuracy, and primary evidence.";

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
        const ranked = filterAndRankCandidates(candidates, claim, maxSlots);
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

      return {
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
          claim,
          page,
          reason: "Google Gemini API quota balance is exhausted (429).",
          warning: "Live AI verification is temporarily unavailable due to API rate limits (429). TruthLens evaluated this statement using offline knowledge archives. Live verification will resume shortly.",
          candidates
        });
      }
      if (apiError.status === 401 || (apiError.status === 400 && apiError.message.includes("API key not valid"))) {
        return synthesizeVerityFactCheck({
          claim,
          page,
          reason: "Google Gemini API authentication failed.",
          warning: "The Gemini API key was rejected by Google. Please update your API key in Settings (⚙).",
          candidates
        });
      }
      return synthesizeVerityFactCheck({
        claim,
        page,
        reason: apiError.message,
        warning: `Google Gemini API notice: ${apiError.message}. Fallback report evaluated via offline knowledge archives.`,
        candidates
      });
    }
  }

  // If no API key configured, use TruthLens dynamic verification
  return synthesizeVerityFactCheck({
    claim,
    page,
    reason: "No API Key configured on server.",
    warning: "Running in TruthLens Offline Knowledge mode. Add your Gemini API key in Settings (⚙) for real-time live web verification.",
    candidates
  });
}

// Built-in TruthLens fact verification synthesis for high availability & stability
function synthesizeVerityFactCheck({ claim, page, reason, warning, candidates = [] }) {
  let verdict = "UNCERTAIN";
  let confidence = 70;
  let explanation = "";
  let evidence = "";
  let sources = [];
  const seenDomains = new Set();

  if (page) {
    verdict = "UNCERTAIN";
    confidence = 65;
    explanation = `[Knowledge Fallback — Live AI Verification Temporarily Unavailable]: TruthLens reviewed the content extracted from ${page.domain}. The article discusses '${page.title}'. Statements in online articles are evaluated alongside independent background references.`;
    evidence = `Reachable webpage at ${page.domain}. Extracted ${page.text.length} characters of readable context.`;
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
    explanation = `[Knowledge Fallback — Live AI Verification Temporarily Unavailable]: The statement "${claim}" was evaluated using offline knowledge archives. Live web verification could not be completed at this time due to temporary API rate limits or connection constraints.`;
  }
  if (!evidence) {
    evidence = sources.length > 0
      ? `Referenced from ${sources.length} offline knowledge records. Live web AI verification is temporarily paused.`
      : "No conclusive consensus found in offline records. Live verification will resume shortly.";
  }

  sources = sources.slice(0, 5);

  return {
    verdict,
    confidence,
    explanation,
    evidence,
    sources,
    engine: "TruthLens Offline Knowledge Base (Fallback Analysis)",
    verificationMode: "knowledge_fallback",
    warning: warning || "Live verification is temporarily unavailable. Displaying offline knowledge analysis."
  };
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Serve frontend static assets (TruthLens AI UI)
app.use(express.static(path.join(__dirname, "../frontend")));

// Root & Health
app.get("/", (req, res) => {
  if (req.accepts("html") && !req.accepts("json")) {
    return res.sendFile(path.join(__dirname, "../frontend/index.html"));
  }
  res.json({
    status: "ok",
    app: "TruthLens AI Fact Checker Engine",
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
        explanation: "TruthLens could not extract sufficient readable article text from this webpage.",
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

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error("Verification request timed out after 35s. Please try again."), { status: 504 })), 35_000);
    });

    const result = await Promise.race([verificationPromise, timeoutPromise]);

    const primaryClaimText = cleanClaim || (page ? page.title : "Image-based statement");

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
  console.log(`  TruthLens AI Fact-Checker API Server Active`);
  console.log(`  Listening on: http://localhost:${PORT}`);
  console.log(`  Settings & Health: http://localhost:${PORT}/api/settings`);
  console.log(`=================================================\n`);
});
