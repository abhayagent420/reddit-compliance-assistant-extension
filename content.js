(() => {
  if (globalThis.__redditComplianceAssistantLoaded) return;
  globalThis.__redditComplianceAssistantLoaded = true;

  const MAX = { title: 500, body: 8000, rules: 8000, draft: 10000 };

  function clean(value, maxLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function findComposer() {
    const active = document.activeElement;
    if (active && (active.matches?.("textarea") || active.isContentEditable) && isVisible(active)) return active;

    const selectors = [
      "textarea[placeholder*='comment' i]",
      "textarea[name='comment']",
      "[contenteditable='true'][role='textbox']",
      "shreddit-composer [contenteditable='true']",
      ".usertext-edit textarea"
    ];
    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(isVisible);
    return candidates.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || null;
  }

  function readComposer() {
    const composer = findComposer();
    if (!composer) return "";
    return clean("value" in composer ? composer.value : composer.innerText, MAX.draft);
  }

  function findPost() {
    return document.querySelector("shreddit-post[post-title]") || document.querySelector("shreddit-post") || document.querySelector(".thing.link");
  }

  function cleanMultiline(value, maxLength) {
    return String(value || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, maxLength);
  }

  function extractRules() {
    const selectors = [
      "shreddit-sidebar-card[heading*='rule' i]",
      "shreddit-subreddit-rules",
      "[data-testid*='subreddit-rules' i]",
      "[data-testid='community-rules']",
      ".side .md"
    ];
    for (const selector of selectors) {
      const candidate = [...document.querySelectorAll(selector)]
        .find((node) => cleanMultiline(node.innerText || node.textContent, MAX.rules).length >= 20);
      if (candidate) {
        return { text: cleanMultiline(candidate.innerText || candidate.textContent, MAX.rules), source: "Reddit sidebar" };
      }
    }

    const headings = [...document.querySelectorAll("h1, h2, h3, h4, [role='heading'], [slot='title']")];
    const rulesHeading = headings.find((node) => /^(community\s+)?rules$|^r\/[^ ]+\s+rules$/i.test(clean(node.textContent, 100)));
    if (rulesHeading) {
      let container = rulesHeading.parentElement;
      while (container && container !== document.body) {
        const candidateText = cleanMultiline(container.innerText || container.textContent, MAX.rules);
        if (candidateText.length >= 40 && /\brules?\b/i.test(candidateText)) {
          return { text: candidateText, source: "Reddit sidebar" };
        }
        container = container.parentElement;
      }
    }

    return { text: "", source: "not found" };
  }

  function extractContext() {
    const post = findPost();
    const subredditFromPath = location.pathname.match(/^\/r\/([^/]+)/i)?.[1] || "";
    const subredditAttribute = post?.getAttribute?.("community-prefixed-name")?.replace(/^r\//i, "") || "";
    const title = post?.getAttribute?.("post-title") || post?.querySelector?.("[slot='title'], a.title, h1")?.textContent || document.querySelector("h1")?.textContent || "";
    const body = post?.querySelector?.("[slot='text-body'], [property='schema:articleBody'], .usertext-body .md")?.innerText || "";

    const rules = extractRules();
    return {
      url: location.href.slice(0, 2000),
      subreddit: clean(subredditAttribute || subredditFromPath, 100),
      postTitle: clean(title, MAX.title),
      postBody: clean(body, MAX.body),
      visibleRules: rules.text,
      rulesSource: rules.source,
      draft: readComposer()
    };
  }

  function insertDraft(text) {
    const composer = findComposer();
    if (!composer) return { ok: false, error: "Open a Reddit comment editor on the page, then try again." };
    composer.focus();
    if ("value" in composer) {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (valueSetter && composer instanceof HTMLTextAreaElement) valueSetter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) {
        composer.textContent = text;
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    }

    const acceptedText = clean("value" in composer ? composer.value : composer.innerText, MAX.draft);
    if (acceptedText !== clean(text, MAX.draft)) {
      return { ok: false, error: "Reddit's editor did not accept automatic insertion. Use Copy and paste the revision instead." };
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EXTRACT_CONTEXT") sendResponse({ ok: true, context: extractContext() });
    else if (message?.type === "INSERT_DRAFT") sendResponse(insertDraft(String(message.text || "").slice(0, MAX.draft)));
  });
})();
