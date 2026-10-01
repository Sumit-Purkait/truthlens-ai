// ==========================================================================
// VERITY AI FACT-CHECKER — CLIENT-SIDE CONTROLLER & ENGINE INTERFACE
// ==========================================================================

// Dynamic API Endpoint (supports same-origin deployments, custom host override, or local dev port 5000)
const API_BASE = window.TRUTHLENS_API_URL ||
  window.VERITY_API_URL ||
  (window.location.protocol.startsWith("http") && !["5500", "5173", "3000", "8000", "8080"].includes(window.location.port)
    ? window.location.origin
    : "http://localhost:5000");

// DOM Element Registry
const $ = (id) => document.getElementById(id);
const dom = {
  // Navigation & Shell
  themeBtn: $("themeBtn"),
  openSettingsBtn: $("openSettingsBtn"),
  engineStatusBadge: $("engineStatusBadge"),
  engineStatusText: $("engineStatusText"),

  // Intake & Controls
  modeTabs: document.querySelectorAll(".mode-tab"),
  claimInput: $("claimInput"),
  urlBadge: $("urlBadge"),
  imageInput: $("imageInput"),
  imagePreview: $("imagePreview"),
  previewImage: $("previewImage"),
  previewFileName: $("previewFileName"),
  previewFileSize: $("previewFileSize"),
  removeImageBtn: $("removeImageBtn"),
  charCount: $("charCount"),
  attachBtn: $("attachBtn"),
  clearBtn: $("clearBtn"),
  micBtn: $("micBtn"),
  verifyBtn: $("verifyBtn"),
  sampleChips: document.querySelectorAll(".sample-chip"),

  // Loading Stage
  loadingStage: $("loadingStage"),
  loadingText: $("loadingText"),
  loadingSubtext: $("loadingSubtext"),
  loadingSteps: $("loadingSteps"),
  pipelineProgressFill: $("pipelineProgressFill"),

  // Results Stage
  resultStage: $("resultStage"),
  copyResultBtn: $("copyResultBtn"),
  copyBtnLabel: $("copyBtnLabel"),
  exportMenuBtn: $("exportMenuBtn"),
  exportDropdownMenu: $("exportDropdownMenu"),
  currentLayoutLabel: $("currentLayoutLabel"),
  exportOptions: document.querySelectorAll(".export-option"),
  downloadBtn: $("downloadBtn"),
  shareBtn: $("shareBtn"),
  settingsNoticeBanner: $("settingsNoticeBanner"),
  settingsNoticeText: $("settingsNoticeText"),
  openSettingsNoticeBtn: $("openSettingsNoticeBtn"),
  breakdownList: $("breakdownList"),
  resultCardContainer: $("resultCardContainer"),
  newCheckBtn: $("newCheckBtn"),

  // Settings Modal
  settingsModal: $("settingsModal"),
  closeSettingsBtn: $("closeSettingsBtn"),
  settingApiKey: $("settingApiKey"),
  toggleApiKeyVisibility: $("toggleApiKeyVisibility"),
  apiKeyStatusTag: $("apiKeyStatusTag"),
  settingModel: $("settingModel"),
  settingBaseUrl: $("settingBaseUrl"),
  segmentButtons: document.querySelectorAll(".segment-btn"),
  testSettingsBtn: $("testSettingsBtn"),
  saveSettingsBtn: $("saveSettingsBtn"),
  testConnectionStatus: $("testConnectionStatus"),

  // Feedback Dock
  errorDock: $("errorDock"),
  toastDock: $("toastDock")
};

// Application State
let appState = {
  selectedFile: null,
  previewObjectUrl: null,
  currentLayout: "grid", // 'grid' | 'clean' | 'spotlight'
  currentResult: null,
  isListening: false,
  isVerifying: false,
  recognition: null,
  settings: {
    apiKey: localStorage.getItem("truthlens_api_key") || localStorage.getItem("verity_api_key") || "",
    model: localStorage.getItem("truthlens_model") || localStorage.getItem("verity_model") || "gemini-3.8-flash",
    baseUrl: localStorage.getItem("truthlens_base_url") || localStorage.getItem("verity_base_url") || "",
    searchDepth: localStorage.getItem("truthlens_search_depth") || localStorage.getItem("verity_search_depth") || "balanced"
  }
};

// Utilities
const esc = (str) => String(str || "").replace(/[&<>'"]/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[c]));

const isWebUrl = (val) => {
  try {
    const url = new URL(val.trim());
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".");
  } catch {
    return false;
  }
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Toast Notification
function showToast(message, duration = 3000) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  dom.toastDock.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(40px)";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Theme Toggle
function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("light", isLight);
  document.body.classList.toggle("dark", !isLight);
  localStorage.setItem("truthlens_theme", theme);
}
applyTheme(localStorage.getItem("truthlens_theme") || localStorage.getItem("verity_theme") || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
dom.themeBtn.addEventListener("click", () => {
  const isLight = document.body.classList.contains("light");
  applyTheme(isLight ? "dark" : "light");
});

// Sync and Load Server Settings
async function initEngineSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.availableModels) && data.availableModels.length > 0) {
        dom.settingModel.innerHTML = data.availableModels.map(m =>
          `<option value="${esc(m.id)}"${(m.id === (appState.settings.model || data.model)) ? " selected" : ""}>${esc(m.name)}${m.recommended ? " [Recommended]" : ""}</option>`
        ).join("");
      }
      if (!appState.settings.apiKey && data.hasApiKey) {
        dom.apiKeyStatusTag.textContent = "Server Key Active";
        dom.settingApiKey.placeholder = data.maskedApiKey || "Server API Key Configured";
      } else if (appState.settings.apiKey) {
        dom.apiKeyStatusTag.textContent = "Custom Key Set";
      } else {
        dom.apiKeyStatusTag.textContent = "No Key Set";
      }
      if (data.model && !localStorage.getItem("truthlens_model") && !localStorage.getItem("verity_model")) {
        dom.settingModel.value = data.model;
        appState.settings.model = data.model;
      }
    }
  } catch {
    dom.engineStatusBadge.title = "Offline / Local Mode";
    dom.engineStatusText.textContent = "Local Mode";
  }
}
initEngineSettings();

// Settings Modal Handlers
function openSettingsModal() {
  dom.settingApiKey.value = appState.settings.apiKey;
  dom.settingModel.value = appState.settings.model;
  dom.settingBaseUrl.value = appState.settings.baseUrl;
  dom.segmentButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.depth === appState.settings.searchDepth);
  });
  dom.testConnectionStatus.hidden = true;
  dom.testConnectionStatus.style.display = "none";

  dom.settingsModal.removeAttribute("hidden");
  dom.settingsModal.classList.add("active");
  dom.settingsModal.style.setProperty("display", "grid", "important");
  dom.settingApiKey.focus();
}

function closeSettingsModal() {
  dom.settingsModal.classList.remove("active");
  dom.settingsModal.setAttribute("hidden", "");
  dom.settingsModal.style.setProperty("display", "none", "important");
}

dom.openSettingsBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  openSettingsModal();
});

dom.closeSettingsBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeSettingsModal();
});

dom.settingsModal.addEventListener("click", (e) => {
  if (e.target === dom.settingsModal) {
    e.preventDefault();
    e.stopPropagation();
    closeSettingsModal();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (dom.settingsModal.classList.contains("active")) {
      e.preventDefault();
      closeSettingsModal();
    }
    if (!dom.exportDropdownMenu.hidden) {
      dom.exportDropdownMenu.hidden = true;
      dom.exportMenuBtn.setAttribute("aria-expanded", "false");
    }
  }
});

// Toggle API Key Visibility
dom.toggleApiKeyVisibility.addEventListener("click", () => {
  const isPass = dom.settingApiKey.type === "password";
  dom.settingApiKey.type = isPass ? "text" : "password";
});

// Segmented Buttons in Settings
dom.segmentButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    dom.segmentButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    appState.settings.searchDepth = btn.dataset.depth;
  });
});

// Test Connection
dom.testSettingsBtn.addEventListener("click", async () => {
  const testKey = dom.settingApiKey.value.trim();
  const testModel = dom.settingModel.value;
  const testBaseUrl = dom.settingBaseUrl.value.trim();

  dom.testSettingsBtn.disabled = true;
  dom.testConnectionStatus.hidden = false;
  dom.testConnectionStatus.className = "test-feedback-box";
  dom.testConnectionStatus.textContent = "Testing connection with AI Engine...";

  try {
    const res = await fetch(`${API_BASE}/api/settings/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: testKey, model: testModel, baseUrl: testBaseUrl })
    });
    const result = await res.json();
    if (result.success) {
      dom.testConnectionStatus.className = "test-feedback-box success";
      dom.testConnectionStatus.textContent = `✓ ${result.message}`;
    } else {
      dom.testConnectionStatus.className = "test-feedback-box error";
      dom.testConnectionStatus.textContent = `⚠ ${result.message || "Connection failed."}`;
    }
  } catch (err) {
    dom.testConnectionStatus.className = "test-feedback-box error";
    dom.testConnectionStatus.textContent = `Network Error: Could not reach backend server at ${API_BASE}.`;
  } finally {
    dom.testSettingsBtn.disabled = false;
  }
});

// Save Settings
dom.saveSettingsBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();

  appState.settings.apiKey = dom.settingApiKey.value.trim();
  appState.settings.model = dom.settingModel.value;
  appState.settings.baseUrl = dom.settingBaseUrl.value.trim();

  localStorage.setItem("truthlens_api_key", appState.settings.apiKey);
  localStorage.setItem("truthlens_model", appState.settings.model);
  localStorage.setItem("truthlens_base_url", appState.settings.baseUrl);
  localStorage.setItem("truthlens_search_depth", appState.settings.searchDepth);
  // Also keep legacy keys for compatibility
  localStorage.setItem("verity_api_key", appState.settings.apiKey);
  localStorage.setItem("verity_model", appState.settings.model);

  // Close modal immediately so UI is responsive
  closeSettingsModal();
  showToast("Settings updated successfully");

  // Sync to backend asynchronously
  try {
    await fetch(`${API_BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appState.settings)
    });
  } catch {}

  initEngineSettings();
});

// Image Handling
function clearSelectedImage() {
  appState.selectedFile = null;
  dom.imageInput.value = "";
  dom.previewImage.removeAttribute("src");
  dom.imagePreview.hidden = true;
  if (appState.previewObjectUrl) {
    URL.revokeObjectURL(appState.previewObjectUrl);
    appState.previewObjectUrl = null;
  }
}

function handleFileSelection(file) {
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    showToast("Please select a PNG, JPEG, WebP, or GIF image.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("Selected image must be under 10 MB.");
    return;
  }

  if (appState.previewObjectUrl) URL.revokeObjectURL(appState.previewObjectUrl);
  appState.selectedFile = file;
  appState.previewObjectUrl = URL.createObjectURL(file);

  dom.previewImage.src = appState.previewObjectUrl;
  dom.previewFileName.textContent = file.name;
  dom.previewFileSize.textContent = formatBytes(file.size);
  dom.imagePreview.hidden = false;
}

dom.attachBtn.addEventListener("click", () => dom.imageInput.click());
dom.imageInput.addEventListener("change", () => handleFileSelection(dom.imageInput.files[0]));
dom.removeImageBtn.addEventListener("click", clearSelectedImage);

// Drag & Drop onto Input Box
const inputCard = $("inputContainer");
inputCard.addEventListener("dragover", (e) => {
  e.preventDefault();
  inputCard.style.borderColor = "var(--border-active)";
});
inputCard.addEventListener("dragleave", () => {
  inputCard.style.borderColor = "";
});
inputCard.addEventListener("drop", (e) => {
  e.preventDefault();
  inputCard.style.borderColor = "";
  if (e.dataTransfer.files?.length) {
    handleFileSelection(e.dataTransfer.files[0]);
  }
});

// Clipboard Image Paste (e.g. Snipping Tool screenshot)
window.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.indexOf("image") !== -1) {
      const file = item.getAsFile();
      handleFileSelection(file);
      showToast("Screenshot captured from clipboard!");
      break;
    }
  }
});

// Text Input Events & URL Detection
function updateInputState() {
  const val = dom.claimInput.value;
  dom.charCount.textContent = `${val.length}/8000`;
  const trimmed = val.trim();
  dom.urlBadge.hidden = !isWebUrl(trimmed);
}

dom.claimInput.addEventListener("input", updateInputState);
dom.claimInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    checkClaim();
  }
});

// Clear All Input
function clearAll() {
  if (appState.isListening) stopVoiceRecognition();
  dom.claimInput.value = "";
  clearSelectedImage();
  updateInputState();
  dom.errorDock.hidden = true;
  dom.resultStage.hidden = true;
  dom.claimInput.focus();
}
dom.clearBtn.addEventListener("click", clearAll);

// Sample Chips
dom.sampleChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    dom.claimInput.value = chip.textContent.trim();
    updateInputState();
    checkClaim();
  });
});

// Mode Tabs
dom.modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    dom.modeTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.mode;
    if (mode === "image") {
      dom.imageInput.click();
    } else if (mode === "url") {
      dom.claimInput.placeholder = "Paste a public URL (e.g., https://example.com/article)...";
      dom.claimInput.focus();
    } else {
      dom.claimInput.placeholder = "Paste an article URL, news headline, or state a claim to fact-check…";
      dom.claimInput.focus();
    }
  });
});

// Voice Input (Speech Recognition)
function setupVoiceRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    showToast("Voice input is not supported in this browser.");
    return null;
  }
  const rec = new SpeechRec();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";

  let initialText = "";
  rec.onstart = () => {
    appState.isListening = true;
    initialText = dom.claimInput.value;
    dom.micBtn.classList.add("listening");
    showToast("Listening... speak your claim clearly.");
  };

  rec.onresult = (e) => {
    let transcript = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    dom.claimInput.value = [initialText, transcript].filter(Boolean).join(" ");
    updateInputState();
  };

  rec.onend = () => {
    stopVoiceRecognition();
  };

  rec.onerror = (e) => {
    stopVoiceRecognition();
    if (e.error !== "no-speech") {
      showToast("Voice recognition interrupted. Please check microphone access.");
    }
  };

  return rec;
}

function stopVoiceRecognition() {
  appState.isListening = false;
  dom.micBtn.classList.remove("listening");
  try { appState.recognition?.stop(); } catch {}
}

dom.micBtn.addEventListener("click", async () => {
  if (appState.isListening) {
    stopVoiceRecognition();
    return;
  }
  if (!appState.recognition) {
    appState.recognition = setupVoiceRecognition();
  }
  if (appState.recognition) {
    try {
      appState.recognition.start();
    } catch {
      stopVoiceRecognition();
    }
  }
});

// Helper: Convert File to Base64
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error("Unable to read image file."));
  reader.readAsDataURL(file);
});

// Cinematic 5-Stage Verification Progress Pipeline
let stepInterval = null;
const ANALYSIS_STAGES = [
  {
    title: "Analyzing the claim",
    subtitle: "Breaking the claim into verifiable facts...",
    progress: 20
  },
  {
    title: "Cross-checking sources",
    subtitle: "Searching for supporting and conflicting evidence...",
    progress: 40
  },
  {
    title: "Evaluating evidence",
    subtitle: "Comparing information across sources...",
    progress: 65
  },
  {
    title: "Verifying credibility",
    subtitle: "Evaluating source credibility...",
    progress: 85
  },
  {
    title: "Finalizing result",
    subtitle: "Preparing the final fact-check...",
    progress: 96
  }
];

function startLoadingAnimation(isUrl) {
  dom.loadingStage.classList.remove("fade-out");
  dom.loadingStage.hidden = false;
  dom.resultStage.hidden = true;
  dom.errorDock.hidden = true;
  dom.verifyBtn.disabled = true;

  const firstStage = isUrl
    ? {
        title: "Analyzing the webpage claim",
        subtitle: "Extracting webpage text & core claims...",
        progress: 20
      }
    : ANALYSIS_STAGES[0];

  if (dom.loadingText) dom.loadingText.textContent = firstStage.title;
  if (dom.loadingSubtext) dom.loadingSubtext.textContent = firstStage.subtitle;
  if (dom.pipelineProgressFill) dom.pipelineProgressFill.style.width = `${firstStage.progress}%`;

  const steps = dom.loadingSteps.querySelectorAll(".step-line");
  let activeStep = 0;
  steps.forEach((s, idx) => {
    s.classList.toggle("active", idx === 0);
    s.classList.remove("completed");
  });

  setTimeout(() => {
    dom.loadingStage.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 100);

  if (stepInterval) clearInterval(stepInterval);
  stepInterval = setInterval(() => {
    if (activeStep < ANALYSIS_STAGES.length - 1) {
      activeStep++;
      steps.forEach((s, idx) => {
        s.classList.toggle("active", idx === activeStep);
        s.classList.toggle("completed", idx < activeStep);
      });
      const stage = ANALYSIS_STAGES[activeStep];
      if (dom.loadingText) dom.loadingText.textContent = stage.title;
      if (dom.loadingSubtext) {
        dom.loadingSubtext.style.opacity = "0";
        setTimeout(() => {
          dom.loadingSubtext.textContent = stage.subtitle;
          dom.loadingSubtext.style.opacity = "1";
        }, 150);
      }
      if (dom.pipelineProgressFill) {
        dom.pipelineProgressFill.style.width = `${stage.progress}%`;
      }
    }
  }, 1600);
}

async function completeLoadingAnimation() {
  if (stepInterval) {
    clearInterval(stepInterval);
    stepInterval = null;
  }
  const steps = dom.loadingSteps.querySelectorAll(".step-line");
  steps.forEach(s => {
    s.classList.remove("active");
    s.classList.add("completed");
  });
  if (dom.pipelineProgressFill) {
    dom.pipelineProgressFill.style.width = "100%";
  }
  if (dom.loadingText) {
    dom.loadingText.textContent = "Finalizing result";
  }
  if (dom.loadingSubtext) {
    dom.loadingSubtext.textContent = "Analysis complete. Generating report...";
  }
  dom.loadingStage.classList.add("fade-out");
  await new Promise(r => setTimeout(r, 280));
  dom.loadingStage.hidden = true;
  dom.loadingStage.classList.remove("fade-out");
}

function stopLoadingAnimation() {
  dom.loadingStage.hidden = true;
  dom.loadingStage.classList.remove("fade-out");
  dom.verifyBtn.disabled = false;
  dom.verifyBtn.removeAttribute("aria-busy");
  if (stepInterval) {
    clearInterval(stepInterval);
    stepInterval = null;
  }
}

// Core Verification Request Runner (Protected against duplicate concurrent clicks)
async function checkClaim() {
  if (appState.isVerifying) return;

  const inputVal = dom.claimInput.value.trim();
  const hasUrl = isWebUrl(inputVal);
  const targetUrl = hasUrl ? inputVal : "";
  const claimText = hasUrl ? "" : inputVal;

  if (!claimText && !targetUrl && !appState.selectedFile) {
    showToast("Enter a claim, paste a website URL, or attach an image.");
    dom.claimInput.focus();
    return;
  }

  appState.isVerifying = true;
  dom.verifyBtn.disabled = true;
  dom.verifyBtn.setAttribute("aria-busy", "true");
  startLoadingAnimation(!!targetUrl);

  try {
    let base64Image = null;
    if (appState.selectedFile) {
      base64Image = await fileToBase64(appState.selectedFile);
    }

    const payload = {
      claim: claimText,
      url: targetUrl,
      image: base64Image,
      settings: {
        apiKey: appState.settings.apiKey || undefined,
        model: appState.settings.model,
        baseUrl: appState.settings.baseUrl || undefined,
        searchDepth: appState.settings.searchDepth
      }
    };

    const res = await fetch(`${API_BASE}/api/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(appState.settings.apiKey ? { "x-api-key": appState.settings.apiKey } : {}),
        ...(appState.settings.model ? { "x-model": appState.settings.model } : {})
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const err = new Error(data.error || "The verification could not be completed.");
      err.status = res.status;
      throw err;
    }

    appState.currentResult = data;
    await completeLoadingAnimation();
    renderResults(data);
  } catch (error) {
    stopLoadingAnimation();
    displayError(error, error.status || 0);
  } finally {
    appState.isVerifying = false;
    stopLoadingAnimation();
  }
}

dom.verifyBtn.addEventListener("click", checkClaim);

// Comprehensive Error Renderer with Accessible Actions
function displayError(err, status = 0) {
  dom.errorDock.hidden = false;
  dom.resultStage.hidden = true;

  const rawMsg = typeof err === "string" ? err : (err?.message || "An unexpected error occurred.");
  const lower = rawMsg.toLowerCase();

  let title = "Verification Interrupted";
  let description = rawMsg;
  let showSettings = false;
  let showRetry = true;

  if (status === 429 || lower.includes("429") || lower.includes("quota") || lower.includes("rate limit") || lower.includes("resource_exhausted")) {
    title = "API Rate Limit Notice (429)";
    description = "Google Gemini's free-tier request limit was reached. Please wait a moment and try again, or configure your own Gemini API key in Settings.";
    showSettings = true;
  } else if (status === 504 || lower.includes("504") || lower.includes("timed out") || lower.includes("timeout")) {
    title = "Verification Timed Out";
    description = "The verification took longer than expected to analyze sources. This usually happens during high network latency. Please try again.";
  } else if (status === 401 || lower.includes("401") || lower.includes("authentication") || lower.includes("key is invalid")) {
    title = "Authentication Error (401)";
    description = "The configured Gemini API key was rejected by Google. Please check and update your API key in Settings.";
    showSettings = true;
  } else if (lower.includes("enter a valid") || lower.includes("url") || lower.includes("intranet") || lower.includes("private") || lower.includes("supported")) {
    title = "Webpage Address Notice";
    description = rawMsg.includes("private") || rawMsg.includes("intranet") || rawMsg.includes("localhost")
      ? "For security reasons, private or localhost intranet addresses cannot be verified. Please provide a public HTTP/HTTPS URL."
      : (rawMsg || "Please enter a valid, reachable public website URL.");
    showRetry = false;
  } else if (lower.includes("image") || lower.includes("10 mb")) {
    title = "Image Upload Issue";
    description = rawMsg || "Please select a standard PNG, JPEG, WebP, or GIF image under 10 MB.";
  } else if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    title = "Backend Connection Failed";
    description = `Could not communicate with the FACTSIFT AI backend server at ${API_BASE}. Please verify the backend is running on port 5000.`;
  }

  dom.errorDock.innerHTML = `
    <div class="error-dock-content">
      <div class="error-header-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <h3>${esc(title)}</h3>
      </div>
      <p>${esc(description)}</p>
      <div class="error-actions">
        ${showRetry ? '<button class="action-pill-btn" id="errorRetryBtn" type="button">Try Again</button>' : ""}
        ${showSettings ? '<button class="action-pill-btn" id="errorSettingsBtn" type="button" style="border-color: var(--accent-purple);">Open Settings ⚙</button>' : ""}
        <button class="action-pill-btn" id="errorDismissBtn" type="button">Dismiss</button>
      </div>
    </div>
  `;

  const retryBtn = $("errorRetryBtn");
  if (retryBtn) retryBtn.addEventListener("click", () => { dom.errorDock.hidden = true; checkClaim(); });

  const settingsBtn = $("errorSettingsBtn");
  if (settingsBtn) settingsBtn.addEventListener("click", openSettingsModal);

  const dismissBtn = $("errorDismissBtn");
  if (dismissBtn) dismissBtn.addEventListener("click", () => { dom.errorDock.hidden = true; });

  dom.errorDock.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Render Results Stage (Matches Screenshots 2, 4, 1)
function renderResults(data) {
  dom.errorDock.hidden = true;
  dom.resultStage.hidden = false;

  // Settings Warning Banner if engine used fallback
  if (data.warning) {
    dom.settingsNoticeBanner.hidden = false;
    dom.settingsNoticeText.textContent = data.warning;
    dom.openSettingsNoticeBtn.onclick = openSettingsModal;
  } else {
    dom.settingsNoticeBanner.hidden = true;
  }

  // Claim Breakdown List
  const breakdownItems = data.breakdown || [
    { id: 1, text: data.claim, verdict: data.verdict }
  ];

  dom.breakdownList.innerHTML = breakdownItems.map((item) => {
    const verdictClass = (item.verdict || "uncertain").toLowerCase();
    return `
      <div class="breakdown-item">
        <div class="breakdown-item-left">
          <span class="claim-index-badge">${item.id || 1}</span>
          <span class="breakdown-claim-text">${esc(item.text)}</span>
        </div>
        <span class="verdict-pill ${verdictClass}">${esc(item.verdict || "UNCERTAIN")}</span>
      </div>
    `;
  }).join("");

  // Render Primary Result Card in Current Layout
  renderLayoutCard(data, appState.currentLayout);

  // Smooth scroll into results
  dom.resultStage.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Layout Switcher (Grid / Clean / Spotlight)
function renderLayoutCard(data, layout) {
  const verdict = (data.verdict || "UNCERTAIN").toUpperCase();
  const verdictClass = verdict.toLowerCase();
  const confidence = Number(data.confidence) || 85;

  dom.resultCardContainer.className = `result-dynamic-container layout-${layout}`;

  // Secondary badge logic (e.g. FALSE + Misleading checkmark pill matching screenshot 4)
  let secondaryPill = "";
  if (verdict === "FALSE") {
    secondaryPill = `<span class="verdict-pill misleading">✔ Misleading</span>`;
  } else if (verdict === "TRUE") {
    secondaryPill = `<span class="verdict-pill true">✔ Verified Facts</span>`;
  } else if (verdict === "MISLEADING") {
    secondaryPill = `<span class="verdict-pill false">False Context</span>`;
  }

  // Verification mode badge (Live Web vs Knowledge Fallback)
  const isFallback = data.verificationMode === "knowledge_fallback" || (data.engine && data.engine.includes("Fallback"));
  const modeBadge = isFallback
    ? `<span class="verdict-pill fallback-mode-pill" style="background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.35); font-weight: 600;">⚡ Knowledge Fallback (Live AI Paused)</span>`
    : `<span class="verdict-pill live-mode-pill" style="background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.35); font-weight: 600;">🌐 Live Web Grounded</span>`;

  // Sources Cards
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const sourcesHtml = sources.length ? sources.map((s) => {
    const rawUrl = s.url && typeof s.url === "string" ? s.url.trim() : "";
    const isSafeUrl = /^https?:\/\//i.test(rawUrl);
    const href = isSafeUrl ? esc(rawUrl) : "#";
    const title = esc(s.title || s.domain || "Reference Source");
    const domainText = esc(s.publisher ? `${s.publisher} • ${s.domain}` : (s.domain || "Web Resource"));
    const type = esc(s.type || "Verified Source");
    return `
    <a class="source-anchor-card" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${title} on ${domainText} (opens in a new tab)">
      <div class="source-card-info">
        <div class="source-top-meta">
          <span class="source-type-tag">${type}</span>
          <span class="source-domain-text">${domainText}</span>
        </div>
        <strong class="source-title-text">${title}</strong>
      </div>
      <div class="source-icon-wrap">
        <svg class="source-external-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
      </div>
    </a>
  `;
  }).join("") : `<p class="field-hint">${isFallback ? "No external background references were found for this offline check." : "No external web links were referenced for this check."}</p>`;

  dom.resultCardContainer.innerHTML = `
    <div class="result-card-inner">
      <div class="card-top-row">
        <div class="claim-title-wrap">
          <span class="eyebrow-tag">EVALUATED STATEMENT</span>
          <h3>Claim 1: ${esc(data.claim)}</h3>
          <div class="badge-row">
            <span class="verdict-pill ${verdictClass}">${verdict}</span>
            ${secondaryPill}
            ${modeBadge}
          </div>
          <span class="field-hint" style="font-size: 0.8rem; margin-top: 6px; display: block;">Engine: <strong>${esc(data.engine || "FACTSIFT AI Engine")}</strong></span>
        </div>

        <div class="confidence-gauge-card">
          <div class="confidence-info-row">
            <span class="confidence-label-tag">CONFIDENCE</span>
            <span class="confidence-numeric-val">${confidence}%</span>
          </div>
          <div class="confidence-bar-track" role="progressbar" aria-valuenow="${confidence}" aria-valuemin="0" aria-valuemax="100">
            <div class="confidence-bar-fill" style="width: ${confidence}%;"></div>
          </div>
        </div>
      </div>

      <div class="analysis-columns">
        <div class="section-box analysis-box">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            <span>ANALYSIS</span>
          </div>
          <p class="section-text">${esc(data.explanation || data.analysis || "Analysis complete.")}</p>
        </div>

        <div class="section-box evidence-box">
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
            <span>KEY EVIDENCE</span>
          </div>
          <p class="section-text">${esc(data.evidence || "No specific evidence flags recorded.")}</p>
        </div>
      </div>

      <div class="sources-card-block">
        <div class="sources-header-row">
          <div class="sources-title-group">
            <span class="section-label">${isFallback ? "BACKGROUND REFERENCES" : "REFERENCED SOURCES"}</span>
            <span class="sources-count-badge">${sources.length}</span>
          </div>
          <span class="field-hint">${isFallback ? "Offline knowledge records" : "Live web grounded verification"}</span>
        </div>
        <div class="sources-grid">
          ${sourcesHtml}
        </div>
      </div>
    </div>
  `;
}

// Export Dropdown Controls
dom.exportMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isHidden = dom.exportDropdownMenu.hidden;
  dom.exportDropdownMenu.hidden = !isHidden;
  dom.exportMenuBtn.setAttribute("aria-expanded", String(isHidden));
});

document.addEventListener("click", () => {
  dom.exportDropdownMenu.hidden = true;
  dom.exportMenuBtn.setAttribute("aria-expanded", "false");
});

dom.exportOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    dom.exportOptions.forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    const layout = btn.dataset.layout;
    appState.currentLayout = layout;
    dom.currentLayoutLabel.textContent = layout.charAt(0).toUpperCase() + layout.slice(1);
    dom.exportDropdownMenu.hidden = true;

    if (appState.currentResult) {
      renderLayoutCard(appState.currentResult, layout);
    }
  });
});

// Copy Summary Action
dom.copyResultBtn.addEventListener("click", async () => {
  if (!appState.currentResult) return;
  const d = appState.currentResult;
  const modeText = d.verificationMode === "knowledge_fallback" ? "Offline Knowledge Fallback" : "Live Web Grounded";
  const textSummary = `[FACTSIFT FACT CHECK]\nClaim: ${d.claim}\nVerdict: ${d.verdict} (${d.confidence}% Confidence)\nMode: ${modeText}\nEngine: ${d.engine || "FACTSIFT AI"}\n\nAnalysis:\n${d.explanation}\n\nEvidence:\n${d.evidence}\n\nGenerated with FACTSIFT AI.`;

  try {
    await navigator.clipboard.writeText(textSummary);
    dom.copyBtnLabel.textContent = "Copied!";
    showToast("Summary copied to clipboard!");
    setTimeout(() => {
      dom.copyBtnLabel.textContent = "Copy";
    }, 2000);
  } catch {
    showToast("Could not copy to clipboard.");
  }
});

// Download PDF Report
dom.downloadBtn.addEventListener("click", () => {
  if (!appState.currentResult) {
    showToast("No verification result to download.");
    return;
  }
  if (typeof window.html2pdf !== "function") {
    showToast("PDF generator is initializing. Please try again shortly.");
    return;
  }
  showToast("Preparing PDF report...");
  const reportElement = dom.resultCardContainer.cloneNode(true);
  const opt = {
    margin: 12,
    filename: `FACTSIFT-Fact-Check-${Date.now()}.pdf`,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  };
  window.html2pdf().set(opt).from(reportElement).save()
    .then(() => showToast("PDF Report downloaded!"))
    .catch(() => showToast("Could not generate PDF report."));
});

// Share Action
dom.shareBtn.addEventListener("click", async () => {
  if (!appState.currentResult) {
    showToast("No verification result to share.");
    return;
  }
  const d = appState.currentResult;
  if (navigator.share) {
    try {
      await navigator.share({
        title: `FACTSIFT Fact Check: ${d.claim}`,
        text: `Verdict: ${d.verdict} (${d.confidence}%) — ${d.explanation}`,
        url: window.location.href
      });
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // User cancelled native share sheet
    }
  }
  // Fallback to clipboard
  dom.copyResultBtn.click();
});

// Reset New Check
dom.newCheckBtn.addEventListener("click", () => {
  clearAll();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// Ensure settings modal starts strictly closed
closeSettingsModal();
