const elements = Object.fromEntries([
  "page-status", "context-diagnostics", "draft", "comment-goal", "comment-type", "generate", "relationship", "product", "rules", "rules-status", "preflight", "error", "analyze", "result",
  "risk-badge", "recommendation", "summary", "concerns-wrap", "concerns", "transparency-wrap",
  "transparency", "ideas-wrap", "ideas", "revision", "copy", "insert", "proxy-url"
].map((id) => [id, document.getElementById(id)]));

let activeTabId = null;
let pageContext = {};

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

async function sendToTab(message) {
  if (!activeTabId) throw new Error("No active Reddit tab was found.");
  return chrome.tabs.sendMessage(activeTabId, message);
}

async function fetchSubredditRules(subreddit) {
  const response = await fetch(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/about/rules.json?raw_json=1`, {
    credentials: "omit",
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Reddit rules endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  const rules = Array.isArray(payload?.rules) ? payload.rules : [];
  const formatted = rules.map((rule, index) => {
    const title = String(rule.short_name || rule.violation_reason || `Rule ${index + 1}`).trim();
    const description = String(rule.description || "").trim();
    return `${index + 1}. ${title}${description ? `\n${description}` : ""}`;
  }).join("\n\n").slice(0, 8000);
  if (!formatted) throw new Error("Reddit returned no public rules");
  return { text: formatted, count: rules.length, source: "Reddit rules API" };
}

function updateContextDiagnostics() {
  const hasPost = Boolean(pageContext.postTitle || pageContext.postBody);
  const hasRules = Boolean(elements.rules.value.trim());
  const hasDraft = Boolean(elements.draft.value.trim());
  const rulesLabel = hasRules
    ? `${pageContext.rulesCount || "rules"} loaded via ${pageContext.rulesSource || "page"}`
    : "MISSING — paste rules before relying on the result";
  elements["context-diagnostics"].textContent = `Post context: ${hasPost ? "loaded" : "missing"} • Rules: ${rulesLabel} • Draft: ${hasDraft ? "loaded" : "enter manually"}`;
  elements["context-diagnostics"].classList.toggle("missing", !hasPost || !hasRules);
  elements["rules-status"].textContent = hasRules
    ? `Rules loaded automatically from ${pageContext.rulesSource || "Reddit"}. Review them for completeness.`
    : "No rules were found automatically. Paste the subreddit rules here; analysis without them is less reliable.";
}

async function loadPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(www\.|old\.)?reddit\.com\//i.test(tab.url || "")) {
    elements["page-status"].textContent = "Open a Reddit post or subreddit page to use page context.";
    elements["context-diagnostics"].textContent = "Post context and subreddit rules are unavailable on this page.";
    elements["context-diagnostics"].classList.add("missing");
    elements["rules-status"].textContent = "Open Reddit or paste the rules manually.";
    return;
  }

  activeTabId = tab.id;
  try {
    const response = await sendToTab({ type: "EXTRACT_CONTEXT" });
    if (!response?.ok) throw new Error(response?.error || "Could not read this page.");
    pageContext = response.context || {};
    if (pageContext.draft) elements.draft.value = pageContext.draft;

    if (pageContext.subreddit) {
      try {
        const apiRules = await fetchSubredditRules(pageContext.subreddit);
        pageContext.visibleRules = apiRules.text;
        pageContext.rulesSource = apiRules.source;
        pageContext.rulesCount = apiRules.count;
      } catch {
        pageContext.rulesSource = pageContext.visibleRules ? (pageContext.rulesSource || "Reddit sidebar") : "not found";
      }
    }

    if (pageContext.visibleRules) elements.rules.value = pageContext.visibleRules;
    const label = pageContext.subreddit ? `r/${pageContext.subreddit}` : "this Reddit page";
    elements["page-status"].textContent = `Context loaded from ${label}${pageContext.postTitle ? `: ${pageContext.postTitle.slice(0, 90)}` : ""}.`;
    updateContextDiagnostics();
  } catch {
    elements["page-status"].textContent = "Reload the Reddit tab once after installing or updating the extension, then reopen this popup.";
    elements["context-diagnostics"].textContent = "Could not read the Reddit page. Draft and rules must be entered manually.";
    elements["context-diagnostics"].classList.add("missing");
    elements["rules-status"].textContent = "Rules were not loaded.";
  }
}

function evaluateLocalPreflight({ draft, rules, relationship, postTitle, postBody }) {
  const value = draft.toLowerCase();
  const ruleText = rules.toLowerCase();
  const context = `${postTitle || ""} ${postBody || ""}`.toLowerCase();
  const warnings = [];
  const solicitation = /\b(?:dm|direct message|message|contact|inbox)\s+(?:me|us)\b|\bfeel free to (?:dm|message|contact)\b/.test(value);
  const incentive = /\b(?:credits?|referral|affiliate|promo(?:tional)? code|discount code|coupon)\b/.test(value);
  const endorsement = /\b(?:switched? to|try(?:ing)?|check out|sign up|works? (?:great|well)|smooth experience)\b/.test(value);
  const promotional = solicitation || incentive || endorsement || /https?:\/\//.test(value);
  if (solicitation) warnings.push("High: The draft asks readers to DM/contact you, which looks like solicitation.");
  if (incentive) warnings.push("High: Credits, referrals, or discounts are strong promotional signals.");
  if (promotional && /\b(?:no spam|promotion|promotional|referral|affiliate|disguised ads?)\b/.test(ruleText)) warnings.push("High: The loaded rules restrict promotion or spam.");
  if (promotional && ["owner", "affiliate"].includes(relationship) && !/\b(?:i built|i made|i work (?:for|on)|i own|affiliated|affiliate|my company|our product)\b/.test(value)) warnings.push("High: Your selected relationship is not disclosed in the comment.");
  const words = (text) => new Set(text.match(/[a-z0-9]{4,}/g) || []);
  const draftWords = words(value); const contextWords = words(context);
  const overlap = [...draftWords].filter((word) => contextWords.has(word)).length;
  if (promotional && draftWords.size >= 6 && contextWords.size >= 6 && overlap / draftWords.size < 0.08) warnings.push("High: The promotion appears unrelated to the current post.");
  if (!rules.trim()) warnings.push("Caution: Subreddit rules are missing, so the result is incomplete.");
  return warnings;
}

function showPreflight(warnings) {
  elements.preflight.hidden = warnings.length === 0;
  elements.preflight.textContent = warnings.length ? `Immediate preflight warning\n• ${warnings.join("\n• ")}` : "";
}

function appendList(listElement, values) {
  listElement.replaceChildren();
  for (const value of values || []) {
    const item = document.createElement("li");
    item.textContent = typeof value === "string" ? value : `${value.rule || "Concern"}: ${value.reason || ""}`;
    listElement.append(item);
  }
}

function renderResult(data) {
  const risk = ["low", "medium", "high"].includes(data.riskLevel) ? data.riskLevel : "medium";
  elements["risk-badge"].className = `badge ${risk}`;
  elements["risk-badge"].textContent = `${risk} risk`;
  const recommendationLabels = {
    likely_ok: "Likely okay after your review",
    revise: "Revise before posting",
    do_not_post: "Do not post this promotion here"
  };
  elements.recommendation.textContent = recommendationLabels[data.recommendation] || "Review before posting";
  elements.summary.textContent = data.summary || "No summary returned.";
  appendList(elements.concerns, data.ruleConcerns);
  elements["concerns-wrap"].hidden = !data.ruleConcerns?.length;
  appendList(elements.transparency, data.transparencyNotes);
  elements["transparency-wrap"].hidden = !data.transparencyNotes?.length;
  elements.revision.value = data.revisedComment || "";
  elements.result.hidden = false;
}

async function generateIdeas() {
  showError("");
  const commentGoal = elements["comment-goal"].value.trim();
  if (!commentGoal) return showError("Describe the topic or point you want the comment to make.");
  if (!elements.rules.value.trim()) return showError("Subreddit rules are missing. Load or paste them before generating ideas.");
  elements.generate.disabled = true;
  elements.generate.textContent = "Generating…";
  try {
    const proxyUrl = elements["proxy-url"].value.trim().replace(/\/$/, "");
    const response = await fetch(`${proxyUrl}/api/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      ...pageContext, mode: "generate", commentGoal, commentType: elements["comment-type"].value,
      draft: "", visibleRules: elements.rules.value.trim(), relationship: elements.relationship.value, productContext: elements.product.value.trim()
    }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Proxy returned HTTP ${response.status}.`);
    renderResult(payload);
    elements.ideas.replaceChildren();
    for (const idea of payload.commentIdeas || []) {
      const card = document.createElement("div"); card.className = "idea";
      const title = document.createElement("strong"); title.textContent = idea.angle || "Comment idea";
      const text = document.createElement("p"); text.textContent = idea.comment;
      const use = document.createElement("button"); use.type = "button"; use.textContent = "Use this idea";
      use.addEventListener("click", () => { elements.revision.value = idea.comment; });
      card.append(title, text, use); elements.ideas.append(card);
    }
    elements["ideas-wrap"].hidden = !(payload.commentIdeas || []).length;
  } catch (error) { showError(`${error.message} Make sure the local proxy is running.`); }
  finally { elements.generate.disabled = false; elements.generate.textContent = "Generate 3 compliant ideas"; }
}

async function analyze() {
  showError("");
  const draft = elements.draft.value.trim();
  if (!draft && !elements.product.value.trim()) {
    showError("Enter a draft or describe what you want to mention.");
    return;
  }

  const localWarnings = evaluateLocalPreflight({
    draft,
    rules: elements.rules.value.trim(),
    relationship: elements.relationship.value,
    postTitle: pageContext.postTitle,
    postBody: pageContext.postBody
  });
  showPreflight(localWarnings);

  const proxyUrl = elements["proxy-url"].value.trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(proxyUrl)) {
    showError("Enter a valid proxy URL.");
    return;
  }

  await chrome.storage.local.set({ proxyUrl });
  elements.analyze.disabled = true;
  elements.analyze.textContent = "Analyzing…";
  try {
    const response = await fetch(`${proxyUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...pageContext,
        draft,
        visibleRules: elements.rules.value.trim(),
        relationship: elements.relationship.value,
        productContext: elements.product.value.trim()
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Proxy returned HTTP ${response.status}.`);
    renderResult(payload);
  } catch (error) {
    showError(`${error.message} Make sure the local proxy is running.`);
  } finally {
    elements.analyze.disabled = false;
    elements.analyze.textContent = "Analyze draft";
  }
}

elements.generate.addEventListener("click", generateIdeas);
elements.rules.addEventListener("input", updateContextDiagnostics);
elements.draft.addEventListener("input", updateContextDiagnostics);
elements.analyze.addEventListener("click", analyze);
elements.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.revision.value);
  elements.copy.textContent = "Copied";
  setTimeout(() => { elements.copy.textContent = "Copy"; }, 1200);
});
elements.insert.addEventListener("click", async () => {
  showError("");
  try {
    const response = await sendToTab({ type: "INSERT_DRAFT", text: elements.revision.value });
    if (!response?.ok) throw new Error(response?.error || "Could not insert the draft.");
    elements.insert.textContent = "Inserted — review on Reddit";
  } catch (error) {
    showError(error.message);
  }
});

(async () => {
  const saved = await chrome.storage.local.get("proxyUrl");
  if (saved.proxyUrl) elements["proxy-url"].value = saved.proxyUrl;
  await loadPageContext();
})();
