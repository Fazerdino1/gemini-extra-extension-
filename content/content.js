(() => {
  const ROOT_CLASS = "gemini-extra-enabled";
  const MENU_ITEM_ID = "gemini-extra-usage-menu-item";
  const FLYOUT_ID = "gemini-extra-usage-flyout";
  const BUBBLE_ID = "gemini-extra-quota-bubble";
  const TOKEN_WIDGET_ID = "gemini-extra-token-widget";
  const TOKEN_POPOVER_ID = "gemini-extra-token-popover";
  const AT_TOOLBAR_ID = "gemini-extra-at-toolbar";
  const IFRAME_ID = "gemini-extra-usage-frame";
  const REFRESH_INTERVAL_MS = 20000;
  const BASE_ORIGIN = "https://gemini.google.com";

  let activeAtTab = "connectors"; // "media" | "connectors" | "skills" | "all"
  let activeAtSearch = "";
  let isReplacingAtTrigger = false;

  function getAccountPrefix() {
    const match = window.location.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
    return match ? `/u/${match[1]}` : "";
  }

  function getAccountKey() {
    const match = window.location.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
    return match ? `u_${match[1]}` : "u_0";
  }

  function getUsageUrl() {
    return `${BASE_ORIGIN}${getAccountPrefix()}/usage`;
  }

  let isEnabled = true;
  let refreshTimer = null;
  let overlayObserver = null;
  let observedOverlayContainer = null;
  let bodyBootObserver = null;
  let layoutWatchTimer = null;
  let scanDebounceTimer = null;
  let promptResizeObserver = null;
  let observedPromptEl = null;
  let isFetching = false;
  let activeMenuPanel = null;
  let hideFlyoutTimer = null;
  let sendClickBound = false;
  let pointerTrackRaf = null;

  // État du prédicteur de tokens par conversation (persisté dans browser.storage.local)
  const conversationStates = new Map();
  let lastKnownPath = window.location.pathname;
  let tokenTickTimer = null;
  let boundTextareaEl = null;
  let persistTokenTimer = null;

  function createEmptyTokenState() {
    return {
      draftInputTokens: 0,
      draftWords: 0,
      draftChars: 0,
      draftAttachments: 0,
      lastDraftText: "",
      exchangeInputTokens: 0,
      exchangeThinkingTokens: 0,
      exchangeResponseTokens: 0,
      exchangeResponseWords: 0,
      exchangeOutputTokens: 0,
      thinkingSource: "none", // "dom" | "timer" | "none"
      thinkingSeconds: 0,
      completedTotalTokens: 0,
      exchangeCount: 0,
      knownUserCount: 0,
      knownModelCount: 0,
      userCountBeforeSend: 0,
      historyScanned: false,
      isGenerating: false,
      sendTimestamp: 0,
      firstResponseTimestamp: 0,
      responseCountBeforeSend: 0,
      lastResponseText: "",
      lastResponseChangeAt: 0
    };
  }

  let tokenState = createEmptyTokenState();

  let currentQuota = {
    current: { percent: null, resetText: "Chargement...", rawPercentText: "--" },
    weekly: { percent: null, resetText: "Chargement...", rawPercentText: "--" },
    updatedAt: null,
    error: null
  };

  function isUsagePage() {
    return /^(\/u\/\d+)?\/usage(\/|$)/.test(window.location.pathname);
  }

  /**
   * Extrait les informations de quota depuis le texte rendu de /usage.
   */
  function parseUsageText(text) {
    if (!text) return null;

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const extractSection = (keywords) => {
      const startIndex = lines.findIndex((line) =>
        keywords.some((kw) => line.toLowerCase().includes(kw.toLowerCase()))
      );
      if (startIndex === -1) return null;

      let percent = null;
      let rawPercentText = "--";
      let resetText = "";

      const windowLines = lines.slice(startIndex, startIndex + 6);
      for (const line of windowLines) {
        if (percent === null) {
          const pctMatch = line.match(/(\d+(?:[.,]\d+)?)\s*%/);
          if (pctMatch) {
            percent = parseFloat(pctMatch[1].replace(",", "."));
            rawPercentText = `${pctMatch[1]} % utilisé(s)`;
          }
        }
        if (
          !resetText &&
          (line.toLowerCase().includes("réinitialisation") ||
            line.toLowerCase().includes("reset"))
        ) {
          resetText = line;
        }
      }

      if (percent === null) return null;
      return { percent, rawPercentText, resetText: resetText || "—" };
    };

    const current = extractSection(["Utilisation actuelle", "Current usage"]);
    const weekly = extractSection(["Limite hebdomadaire", "Weekly limit"]);

    if (!current && !weekly) return null;

    return {
      current: current || currentQuota.current,
      weekly: weekly || currentQuota.weekly,
      updatedAt: Date.now(),
      error: null
    };
  }

  async function saveAndRenderQuota(parsed, accountKey = getAccountKey()) {
    if (!parsed) return;
    currentQuota = { ...parsed, accountKey };
    try {
      const { quotaByAccount = {} } = await browser.storage.local.get("quotaByAccount");
      quotaByAccount[accountKey] = currentQuota;
      await browser.storage.local.set({
        quotaByAccount,
        activeAccountKey: accountKey,
        quotaData: currentQuota
      });
    } catch (err) {
      console.warn("[Gemini Extra] Erreur sauvegarde quota:", err);
    }
    updateFlyoutContent();
  }

  /**
   * Récupère les données de /usage toutes les 20s :
   * 1) Tente d'abord un fetch() léger (zéro DOM/Angular) ;
   * 2) Sinon utilise une iframe cachée same-origin avec polling doux.
   */
  async function fetchUsageViaIframe(force = false) {
    if (!isEnabled) return;
    if (document.hidden && !force) return;
    if (isFetching && !force) return;

    if (isUsagePage()) {
      const parsed = parseUsageText(document.body?.innerText || "");
      if (parsed) {
        saveAndRenderQuota(parsed);
      }
      return;
    }

    isFetching = true;
    updateRefreshIndicator(true);

    const targetAccountKey = getAccountKey();
    const targetUsageUrl = getUsageUrl();

    // 1. Tentative fetch() ultra-légère (sans lancer d'iframe Angular)
    try {
      const res = await fetch(`${targetUsageUrl}?_ge_t=${Date.now()}`, {
        credentials: "include",
        cache: "no-store"
      });
      if (res.ok) {
        const html = await res.text();
        if (html.includes("%") && (html.includes("Utilisation actuelle") || html.includes("Current usage") || html.includes("Limite hebdomadaire") || html.includes("Weekly limit"))) {
          const stripped = html
            .replace(/<script[\s\S]*?<\/script>/gi, "\n")
            .replace(/<style[\s\S]*?<\/style>/gi, "\n")
            .replace(/<[^>]+>/g, "\n");
          const parsedFromFetch = parseUsageText(stripped);
          if (parsedFromFetch) {
            isFetching = false;
            updateRefreshIndicator(false);
            saveAndRenderQuota(parsedFromFetch, targetAccountKey);
            return;
          }
        }
      }
    } catch {
      // Fallback iframe ci-dessous
    }

    let iframe = document.getElementById(IFRAME_ID);
    if (iframe) {
      iframe.remove();
    }

    iframe = document.createElement("iframe");
    iframe.id = IFRAME_ID;
    iframe.src = `${targetUsageUrl}?_ge_t=${Date.now()}`;
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    Object.assign(iframe.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
      left: "-9999px",
      top: "-9999px",
      border: "0"
    });

    let pollInterval = null;
    let timeoutTimer = null;

    const cleanup = () => {
      if (pollInterval) clearInterval(pollInterval);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      isFetching = false;
      updateRefreshIndicator(false);
    };

    iframe.addEventListener("load", () => {
      let attempts = 0;
      const maxAttempts = 8;

      pollInterval = setInterval(() => {
        attempts += 1;
        try {
          const doc = iframe.contentDocument || iframe.contentWindow?.document;
          const rawTextContent = doc?.body?.textContent || "";
          if (rawTextContent.includes("%")) {
            const text = doc?.body?.innerText || "";
            const parsed = parseUsageText(text);
            if (parsed) {
              cleanup();
              saveAndRenderQuota(parsed, targetAccountKey);
              iframe.remove();
              return;
            }
          }
        } catch (err) {
          cleanup();
          currentQuota = {
            ...currentQuota,
            error: `Accès bloqué (${err?.name || "SecurityError"}) — rechargez la page`
          };
          updateFlyoutContent();
          iframe.remove();
          return;
        }

        if (attempts >= maxAttempts) {
          cleanup();
          if (!currentQuota.updatedAt) {
            currentQuota = {
              ...currentQuota,
              error: "Délai dépassé lors de la lecture de /usage"
            };
            updateFlyoutContent();
          }
          iframe.remove();
        }
      }, 900);
    });

    timeoutTimer = setTimeout(() => {
      if (isFetching) {
        cleanup();
        iframe.remove();
      }
    }, 10000);

    document.body.appendChild(iframe);
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    fetchUsageViaIframe();
    refreshTimer = setInterval(fetchUsageViaIframe, REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    const existingFrame = document.getElementById(IFRAME_ID);
    if (existingFrame) existingFrame.remove();
    isFetching = false;
  }

  function getBarColorClass(percent) {
    if (percent === null || Number.isNaN(percent)) return "";
    if (percent >= 90) return "ge-level-danger";
    if (percent >= 70) return "ge-level-warn";
    return "ge-level-ok";
  }

  function updateRefreshIndicator(spinning) {
    const btn = document.querySelector(`#${FLYOUT_ID} .ge-refresh-btn`);
    if (btn) {
      btn.classList.toggle("ge-spinning", spinning);
    }
  }

  function ensureFlyoutExists() {
    let flyout = document.getElementById(FLYOUT_ID);
    if (flyout) return flyout;

    flyout = document.createElement("div");
    flyout.id = FLYOUT_ID;
    flyout.className = "ge-usage-flyout";
    flyout.hidden = true;
    flyout.setAttribute("role", "dialog");
    flyout.setAttribute("aria-label", "Utilisation Gemini");

    flyout.innerHTML = `
      <div class="ge-flyout-header">
        <div class="ge-flyout-title">
          <span>Utilisation</span>
          <span class="ge-live-badge" title="Actualisation automatique toutes les 20 secondes">20s</span>
        </div>
        <button type="button" class="ge-refresh-btn" title="Actualiser maintenant">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>

      <div class="ge-quota-card">
        <div class="ge-card-top">
          <span class="ge-card-label">Utilisation actuelle</span>
          <span class="ge-card-value" data-field="current-value">--</span>
        </div>
        <div class="ge-progress-track">
          <div class="ge-progress-fill" data-field="current-bar" style="width: 0%"></div>
        </div>
        <div class="ge-card-reset" data-field="current-reset">Chargement...</div>
      </div>

      <div class="ge-quota-card">
        <div class="ge-card-top">
          <span class="ge-card-label">Limite hebdomadaire</span>
          <span class="ge-card-value" data-field="weekly-value">--</span>
        </div>
        <div class="ge-progress-track">
          <div class="ge-progress-fill" data-field="weekly-bar" style="width: 0%"></div>
        </div>
        <div class="ge-card-reset" data-field="weekly-reset">Chargement...</div>
      </div>

      <div class="ge-flyout-error" hidden></div>

      <div class="ge-flyout-footer">
        <span class="ge-updated-at">En attente...</span>
        <button type="button" class="ge-usage-link">Ouvrir /usage ↗</button>
      </div>
    `;

    flyout.addEventListener("mouseenter", () => {
      if (hideFlyoutTimer) {
        clearTimeout(hideFlyoutTimer);
        hideFlyoutTimer = null;
      }
    });

    const refreshBtn = flyout.querySelector(".ge-refresh-btn");
    refreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fetchUsageViaIframe(true);
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => fetchUsageViaIframe(false), REFRESH_INTERVAL_MS);
      }
    });

    const usageBtn = flyout.querySelector(".ge-usage-link");
    usageBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetUrl = getUsageUrl();
      browser.runtime.sendMessage({ action: "openUsagePage", url: targetUrl }).catch(() => {
        window.open(targetUrl, "_blank", "noopener,noreferrer");
      });
    });

    document.body.appendChild(flyout);
    stopBubblePropagation(flyout);
    return flyout;
  }

  function updateFlyoutContent() {
    const flyout = document.getElementById(FLYOUT_ID);
    if (!flyout) return;

    const curVal = flyout.querySelector('[data-field="current-value"]');
    const curBar = flyout.querySelector('[data-field="current-bar"]');
    const curReset = flyout.querySelector('[data-field="current-reset"]');

    const wkVal = flyout.querySelector('[data-field="weekly-value"]');
    const wkBar = flyout.querySelector('[data-field="weekly-bar"]');
    const wkReset = flyout.querySelector('[data-field="weekly-reset"]');

    const errBox = flyout.querySelector(".ge-flyout-error");
    const updatedAtEl = flyout.querySelector(".ge-updated-at");

    const curPct = currentQuota.current?.percent;
    const wkPct = currentQuota.weekly?.percent;

    curVal.textContent = currentQuota.current?.rawPercentText || "--";
    curReset.textContent = currentQuota.current?.resetText || "—";
    curBar.style.width = `${Math.min(100, Math.max(0, curPct || 0))}%`;
    curBar.className = `ge-progress-fill ${getBarColorClass(curPct)}`;

    wkVal.textContent = currentQuota.weekly?.rawPercentText || "--";
    wkReset.textContent = currentQuota.weekly?.resetText || "—";
    wkBar.style.width = `${Math.min(100, Math.max(0, wkPct || 0))}%`;
    wkBar.className = `ge-progress-fill ${getBarColorClass(wkPct)}`;

    if (currentQuota.error) {
      errBox.textContent = currentQuota.error;
      errBox.hidden = false;
    } else {
      errBox.hidden = true;
    }

    if (currentQuota.updatedAt) {
      const timeStr = new Date(currentQuota.updatedAt).toLocaleTimeString("fr-FR");
      updatedAtEl.textContent = `Mis à jour à ${timeStr}`;
    } else {
      updatedAtEl.textContent = "En attente...";
    }

    updateBubbleContent();
  }

  function findPromptBarElement() {
    const richTextarea = document.querySelector("rich-textarea");
    if (richTextarea) {
      let el = richTextarea.parentElement;
      while (el && el !== document.body) {
        const rect = el.getBoundingClientRect();
        // La barre de prompt complète fait typiquement entre 320px et 1100px de large (centrée sur l'accueil ou en bas du chat)
        if (rect.width >= 320 && rect.width <= 1100 && rect.height >= 40 && rect.height <= 300) {
          const style = window.getComputedStyle(el);
          const radius = parseFloat(style.borderRadius) || 0;
          if (radius >= 16 || el.classList.contains("input-area-container") || el.classList.contains("input-area")) {
            return el;
          }
        }
        el = el.parentElement;
      }
    }

    const fallback = document.querySelector(".input-area-container, .input-area");
    return fallback instanceof HTMLElement ? fallback : null;
  }

  function positionQuotaBubble() {
    const bubble = document.getElementById(BUBBLE_ID);
    if (!bubble || !isEnabled) return;

    const promptEl = findPromptBarElement();
    const bubbleSize = 58;
    const gap = 14;

    if (promptEl) {
      if (observedPromptEl !== promptEl) {
        if (promptResizeObserver) promptResizeObserver.disconnect();
        promptResizeObserver = new ResizeObserver(() => positionQuotaBubble());
        promptResizeObserver.observe(promptEl);
        observedPromptEl = promptEl;
      }

      const rect = promptEl.getBoundingClientRect();
      let left = rect.right + gap;
      let top = rect.top + (rect.height - bubbleSize) / 2;

      if (left + bubbleSize > window.innerWidth - 12) {
        left = window.innerWidth - bubbleSize - 16;
        top = window.innerHeight - bubbleSize - 16;
      }

      bubble.style.left = `${Math.round(left)}px`;
      bubble.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - bubbleSize - 12, top)))}px`;
      bubble.style.right = "auto";
      bubble.style.bottom = "auto";
    } else {
      bubble.style.left = "auto";
      bubble.style.top = "auto";
      bubble.style.right = "20px";
      bubble.style.bottom = "24px";
    }
  }

  function ensureBubbleExists() {
    if (!isEnabled) return null;
    let bubble = document.getElementById(BUBBLE_ID);
    if (bubble) {
      positionQuotaBubble();
      return bubble;
    }

    bubble = document.createElement("button");
    bubble.id = BUBBLE_ID;
    bubble.type = "button";
    bubble.className = "ge-quota-bubble";
    bubble.title = "Quota Gemini (5h | Semaine) — Cliquer pour détails";

    bubble.innerHTML = `
      <span class="ge-bubble-half ge-bubble-left">
        <span class="ge-bubble-tag">5h</span>
        <span class="ge-bubble-pct" data-bubble="current">--</span>
      </span>
      <span class="ge-bubble-sep" aria-hidden="true"></span>
      <span class="ge-bubble-half ge-bubble-right">
        <span class="ge-bubble-tag">7j</span>
        <span class="ge-bubble-pct" data-bubble="weekly">--</span>
      </span>
    `;

    bubble.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const flyout = document.getElementById(FLYOUT_ID);
      if (flyout && !flyout.hidden && flyout.dataset.anchor === "bubble") {
        hideFlyoutNow();
      } else {
        showFlyoutForBubble(bubble);
      }
    });

    document.body.appendChild(bubble);
    stopBubblePropagation(bubble);
    positionQuotaBubble();
    updateBubbleContent();
    return bubble;
  }

  function formatCompactPercent(pct) {
    if (pct === null || pct === undefined || Number.isNaN(pct)) return "--";
    return `${Math.round(pct)}%`;
  }

  function updateBubbleContent() {
    const bubble = document.getElementById(BUBBLE_ID);
    if (!bubble) return;

    const curEl = bubble.querySelector('[data-bubble="current"]');
    const wkEl = bubble.querySelector('[data-bubble="weekly"]');
    const curPct = currentQuota.current?.percent;
    const wkPct = currentQuota.weekly?.percent;

    curEl.textContent = formatCompactPercent(curPct);
    curEl.className = `ge-bubble-pct ${getBarColorClass(curPct)}`;

    wkEl.textContent = formatCompactPercent(wkPct);
    wkEl.className = `ge-bubble-pct ${getBarColorClass(wkPct)}`;

    const curFull = currentQuota.current?.rawPercentText || "--";
    const wkFull = currentQuota.weekly?.rawPercentText || "--";
    bubble.title = `5h : ${curFull} | Semaine : ${wkFull} (actualisation 20s)`;
  }

  function showFlyoutForBubble(bubble) {
    if (hideFlyoutTimer) {
      clearTimeout(hideFlyoutTimer);
      hideFlyoutTimer = null;
    }

    const flyout = ensureFlyoutExists();
    updateFlyoutContent();
    flyout.dataset.anchor = "bubble";
    flyout.hidden = false;

    const bRect = bubble.getBoundingClientRect();
    const flyoutWidth = 310;
    let left = bRect.right - flyoutWidth;
    if (left < 12) left = 12;

    flyout.style.left = `${Math.round(left)}px`;
    flyout.style.top = `${Math.max(12, Math.round(bRect.top - 12))}px`;

    requestAnimationFrame(() => {
      const fRect = flyout.getBoundingClientRect();
      const topAbove = bRect.top - fRect.height - 10;
      flyout.style.top = `${Math.max(12, Math.round(topAbove))}px`;
    });
  }

  // Empêche Angular Material de fermer les menus en bloquant la remontée (phase bulle uniquement)
  function stopBubblePropagation(el) {
    if (!el) return;
    for (const evtName of ["pointerdown", "mousedown", "mouseup", "touchstart"]) {
      el.addEventListener(evtName, (e) => e.stopPropagation(), false);
    }
  }

  function getMenuVisualRect(menuPanel, anchorItem) {
    const candidates = [
      anchorItem,
      anchorItem.parentElement,
      menuPanel
    ].filter((el) => el instanceof HTMLElement);

    let bestRect = anchorItem.getBoundingClientRect();
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      // On ignore les wrappers qui font quasiment toute la largeur de l'écran
      if (r.width > 80 && r.width < 520 && r.width >= bestRect.width) {
        bestRect = r;
      }
    }
    return bestRect;
  }

  function isPointInRectWithPadding(x, y, rect, pad = 12) {
    return (
      x >= rect.left - pad &&
      x <= rect.right + pad &&
      y >= rect.top - pad &&
      y <= rect.bottom + pad
    );
  }

  function handlePointerTracking(e) {
    if (pointerTrackRaf) return;
    const clientX = e.clientX;
    const clientY = e.clientY;
    pointerTrackRaf = requestAnimationFrame(() => {
      pointerTrackRaf = null;
      const flyout = document.getElementById(FLYOUT_ID);
      if (!flyout || flyout.hidden || !activeMenuPanel) return;

      const item = document.getElementById(MENU_ITEM_ID);
      const menuRect = item
        ? getMenuVisualRect(activeMenuPanel, item)
        : activeMenuPanel.getBoundingClientRect();
      const flyoutRect = flyout.getBoundingClientRect();

      const insideMenu = isPointInRectWithPadding(clientX, clientY, menuRect, 14);
      const insideFlyout = isPointInRectWithPadding(clientX, clientY, flyoutRect, 12);

      if (insideMenu || insideFlyout) {
        if (hideFlyoutTimer) {
          clearTimeout(hideFlyoutTimer);
          hideFlyoutTimer = null;
        }
      } else {
        scheduleHideFlyout();
      }
    });
  }

  function showFlyout(menuPanel, anchorItem) {
    if (hideFlyoutTimer) {
      clearTimeout(hideFlyoutTimer);
      hideFlyoutTimer = null;
    }

    const flyout = ensureFlyoutExists();
    updateFlyoutContent();
    flyout.dataset.anchor = "menu";
    flyout.hidden = false;

    const menuRect = getMenuVisualRect(menuPanel, anchorItem);
    const itemRect = anchorItem.getBoundingClientRect();
    const flyoutWidth = 310;
    const gap = 10;

    // Position juste à droite du menu des modèles (sans chevauchement), sinon à gauche
    let left = menuRect.right + gap;
    if (left + flyoutWidth > window.innerWidth - 12) {
      left = Math.max(12, menuRect.left - flyoutWidth - gap);
    }

    flyout.style.left = `${left}px`;
    flyout.style.top = `${Math.max(12, itemRect.top - 8)}px`;

    requestAnimationFrame(() => {
      const flyoutRect = flyout.getBoundingClientRect();
      if (flyoutRect.bottom > window.innerHeight - 12) {
        const adjustedTop = Math.max(12, window.innerHeight - flyoutRect.height - 12);
        flyout.style.top = `${adjustedTop}px`;
      }
    });

    anchorItem.classList.add("ge-active");
    document.addEventListener("mousemove", handlePointerTracking, true);
  }

  function hideFlyoutNow() {
    if (hideFlyoutTimer) {
      clearTimeout(hideFlyoutTimer);
      hideFlyoutTimer = null;
    }
    document.removeEventListener("mousemove", handlePointerTracking, true);
    const flyout = document.getElementById(FLYOUT_ID);
    if (flyout) flyout.hidden = true;
    const item = document.getElementById(MENU_ITEM_ID);
    if (item) item.classList.remove("ge-active");
  }

  function scheduleHideFlyout() {
    if (hideFlyoutTimer) return;
    hideFlyoutTimer = setTimeout(() => {
      hideFlyoutNow();
    }, 150);
  }

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  /**
   * Détecte si un élément overlay correspond au menu des modèles Gemini.
   */
  function isModelSelectorMenu(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    // Utiliser textContent (aucun reflow forcé) au lieu de innerText
    const text = (el.textContent || "").toLowerCase();
    const modelMarkers = [
      "aide au quotidien",
      "analyse plus approfondie",
      "code et tâches complexes",
      "niveau de réflexion",
      "s'adapte à vos besoins",
      "4 hydrogen",
      "4 neon",
      "4 carbon",
      "thinking level"
    ];
    return modelMarkers.some((marker) => text.includes(marker));
  }

  /**
   * Trouve le conteneur réel de la liste d'options à l'intérieur du panneau menu.
   */
  function findMenuListContainer(menuPane) {
    const directCandidates = [
      ".mat-mdc-menu-content",
      '[role="menu"]',
      '[role="listbox"]',
      ".mat-mdc-menu-panel"
    ];
    for (const sel of directCandidates) {
      const found = menuPane.querySelector(sel);
      if (found) return found;
    }

    // Sinon, remonter depuis un item connu ("Auto" / "Aide au quotidien")
    const allElements = menuPane.querySelectorAll("button, [role='menuitem'], [role='option'], div");
    for (const el of allElements) {
      const txt = (el.textContent || "").trim().toLowerCase();
      if (txt.startsWith("auto") && txt.includes("besoins")) {
        return el.parentElement || menuPane;
      }
    }

    return menuPane.firstElementChild || menuPane;
  }

  function injectMenuButtonIntoModelMenu(menuPane) {
    if (!isEnabled || !menuPane) return;

    if (menuPane.querySelector(`#${MENU_ITEM_ID}`)) return;

    const menuContent = findMenuListContainer(menuPane);
    const visualPanel =
      menuPane.querySelector(".mat-mdc-menu-panel") ||
      menuPane.firstElementChild ||
      menuPane;

    const itemWrapper = document.createElement("div");
    itemWrapper.id = MENU_ITEM_ID;
    itemWrapper.className = "ge-model-menu-usage-section";

    itemWrapper.innerHTML = `
      <button type="button" class="ge-usage-menu-btn">
        <span class="ge-usage-menu-left">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20V10" />
            <path d="M18 20V4" />
            <path d="M6 20v-4" />
          </svg>
          <span>Voir utilisation</span>
        </span>
        <span class="ge-usage-menu-arrow" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>
      <div class="ge-usage-menu-divider"></div>
    `;

    const btn = itemWrapper.querySelector(".ge-usage-menu-btn");

    btn.addEventListener("mouseenter", () => {
      showFlyout(visualPanel, itemWrapper);
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const flyout = document.getElementById(FLYOUT_ID);
      if (flyout && !flyout.hidden) {
        hideFlyoutNow();
      } else {
        showFlyout(visualPanel, itemWrapper);
      }
    });

    // Insérer tout en haut du menu, au-dessus des modèles
    menuContent.insertBefore(itemWrapper, menuContent.firstChild);
    stopBubblePropagation(itemWrapper);
    activeMenuPanel = menuPane;

    // Retirer le focus initial automatique (cadre blanc) mis par Angular Material sur le 1er item ("Auto")
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement && menuPane.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    });
  }

  function ensureWidgetsMounted() {
    if (!isEnabled) return;

    if (!document.getElementById(BUBBLE_ID)) {
      try { ensureBubbleExists(); } catch (err) { console.error("[Gemini Extra] Erreur bulle:", err); }
    } else if (!observedPromptEl || !document.body.contains(observedPromptEl)) {
      positionQuotaBubble();
    }

    if (!document.getElementById(TOKEN_WIDGET_ID)) {
      try { ensureTokenWidgetInjected(); } catch (err) { console.error("[Gemini Extra] Erreur widget tokens:", err); }
    }

    if (!boundTextareaEl || !document.body.contains(boundTextareaEl)) {
      try { bindPromptInputListeners(); } catch (err) { console.error("[Gemini Extra] Erreur binding input:", err); }
    }

    if (!tokenState.isGenerating) {
      try {
        syncConversationRoute();
        if (!tokenState.historyScanned) {
          scanExistingConversationTokens();
        }
      } catch (err) {
        console.error("[Gemini Extra] Erreur scan historique:", err);
      }
    }

    attachOverlayObserver();

    attachSidebarObserver();
    scheduleSidebarSync();
  }

  function scanOverlaysOnly() {
    if (!isEnabled) return;

    const candidates = document.querySelectorAll(
      '.cdk-overlay-pane, .mat-mdc-menu-panel, [role="menu"], [role="listbox"]'
    );

    let foundMenu = null;
    for (const candidate of candidates) {
      if (isVisible(candidate) && isModelSelectorMenu(candidate)) {
        foundMenu = candidate;
        break;
      }
    }

    if (foundMenu) {
      injectMenuButtonIntoModelMenu(foundMenu);
    } else if (activeMenuPanel && (!document.body.contains(activeMenuPanel) || !isVisible(activeMenuPanel))) {
      activeMenuPanel = null;
      const flyout = document.getElementById(FLYOUT_ID);
      if (flyout && flyout.dataset.anchor !== "bubble") {
        hideFlyoutNow();
      }
    } else if (!foundMenu) {
      activeMenuPanel = null;
      const flyout = document.getElementById(FLYOUT_ID);
      if (flyout && flyout.dataset.anchor !== "bubble") {
        hideFlyoutNow();
      }
    }

    try {
      scanForAtMentionMenu();
    } catch (err) {
      console.error("[Gemini Extra] Erreur menu @:", err);
    }

    try {
      scanForPlusMenu();
    } catch (err) {
      console.error("[Gemini Extra] Erreur séparateurs menu +:", err);
    }
  }

  function scanForModelMenu() {
    scanOverlaysOnly();
    ensureWidgetsMounted();
  }

  // ============================================================================
  // Menu "@" amélioré : séparation Connecteurs / Compétences + recherche rapide
  // ============================================================================

  function isAtMentionMenu(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isModelSelectorMenu(el)) return false;
    const text = (el.textContent || "").toLowerCase();
    // Marqueurs typiques du menu @ (Compétences, Avatar, Connecteurs, etc.)
    const hasSkillsHeader = text.includes("compétences") || text.includes("skills");
    const hasConnectorItems =
      text.includes("ajoutez votre image") ||
      text.includes("google drive") ||
      text.includes("gmail") ||
      text.includes("youtube");
    const hasKebabSkill = /[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/.test(text);
    return hasSkillsHeader || (hasConnectorItems && (hasKebabSkill || text.includes("avatar")));
  }

  function isAutocompleteOverlayOpen() {
    const panes = document.querySelectorAll(".cdk-overlay-pane");
    for (const pane of panes) {
      if (!isVisible(pane)) continue;
      if (
        pane.querySelector(`#${AT_TOOLBAR_ID}`) ||
        isAtMentionMenu(pane) ||
        pane.querySelector('[role="listbox"], [role="option"]')
      ) {
        return true;
      }
    }
    return false;
  }

  function classifyAndFilterAtMenu(menuPane) {
    // Trouver tous les éléments pertinents dans l'ordre exact du DOM (titres + items cliquables)
    const allNodes = Array.from(
      menuPane.querySelectorAll(
        '[role="option"], [role="menuitem"], button, .mat-mdc-list-item, [class*="header" i], [class*="title" i], [class*="label" i], h1, h2, h3, h4, p, span, div'
      )
    ).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.closest(`#${AT_TOOLBAR_ID}`)) return false;
      return true;
    });

    const isItemElement = (el) =>
      el.matches('[role="option"], [role="menuitem"], button, .mat-mdc-list-item, [mat-menu-item]');

    const headers = [];
    const items = [];
    const seenItems = new Set();

    for (const el of allNodes) {
      if (isItemElement(el)) {
        // Éviter les sous-éléments à l'intérieur d'un item déjà collecté
        if (seenItems.has(el) || Array.from(seenItems).some((p) => p.contains(el))) continue;
        seenItems.add(el);
        items.push({ type: "item", el });
        continue;
      }

      // Détecter les titres de section exacts ("Compétences", "Connecteurs") sans enfants items
      const txt = (el.textContent || "").trim().toLowerCase();
      if (
        (txt === "compétences" || txt === "skills" || txt === "connecteurs" || txt === "connectors" || txt === "extensions") &&
        el.children.length === 0
      ) {
        headers.push(el);
        items.push({ type: "header", el, text: txt });
      }
    }

    let currentSection = "media";
    let mediaCount = 0;
    let connectorsCount = 0;
    let skillsCount = 0;

    for (const entry of items) {
      const el = entry.el;
      if (entry.type === "header") {
        if (entry.text === "compétences" || entry.text === "skills") {
          currentSection = "skills";
          el.dataset.geAtRole = "header-skills";
        } else {
          currentSection = "connectors";
          el.dataset.geAtRole = "header-connectors";
        }
        el.classList.toggle("ge-at-hidden", activeAtTab !== "all");
        continue;
      }

      const txt = (el.textContent || "").trim();
      const lower = txt.toLowerCase();
      const isSkillFooter = lower.includes("voir toutes les compétences");
      const isConnFooter = lower.includes("voir tous les connecteurs");
      const isKebab = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/.test(lower);

      let group = currentSection;
      if (isSkillFooter || isKebab) group = "skills";
      else if (isConnFooter) group = "connectors";

      el.dataset.geAtGroup = group;
      el.classList.add("ge-at-item");

      if (group === "skills") {
        skillsCount += 1;
      } else if (group === "connectors") {
        connectorsCount += 1;
      } else {
        mediaCount += 1;
      }

      const matchesTab = activeAtTab === "all" || activeAtTab === group;
      const matchesSearch = !activeAtSearch || lower.includes(activeAtSearch.toLowerCase());
      el.classList.toggle("ge-at-hidden", !(matchesTab && matchesSearch));
    }

    // Masquer les séparateurs et les conteneurs de groupes devenus vides quand un onglet est filtré
    const dividers = menuPane.querySelectorAll('mat-divider, [role="separator"], hr');
    for (const divEl of dividers) {
      if (divEl instanceof HTMLElement && !divEl.closest(`#${AT_TOOLBAR_ID}`)) {
        divEl.classList.toggle("ge-at-hidden", activeAtTab !== "all");
      }
    }

    const groupContainers = new Set();
    for (const entry of items) {
      if (entry.type === "item" && entry.el.parentElement) {
        groupContainers.add(entry.el.parentElement);
      }
    }
    for (const container of groupContainers) {
      if (
        !(container instanceof HTMLElement) ||
        container.id === AT_TOOLBAR_ID ||
        container.querySelector(`#${AT_TOOLBAR_ID}`)
      ) {
        continue;
      }
      const hasVisibleItem = Array.from(container.querySelectorAll(".ge-at-item")).some(
        (it) => !it.classList.contains("ge-at-hidden")
      );
      container.classList.toggle("ge-at-hidden", !hasVisibleItem);
    }

    // Mettre à jour les compteurs sur la barre d'onglets
    const toolbar = menuPane.querySelector(`#${AT_TOOLBAR_ID}`);
    if (toolbar) {
      const mediaBadge = toolbar.querySelector('[data-at-count="media"]');
      const mediaTab = toolbar.querySelector('[data-at-tab="media"]');
      const connBadge = toolbar.querySelector('[data-at-count="connectors"]');
      const skillBadge = toolbar.querySelector('[data-at-count="skills"]');
      if (mediaBadge) mediaBadge.textContent = String(mediaCount);
      if (mediaTab) mediaTab.hidden = mediaCount === 0;
      if (connBadge) connBadge.textContent = String(connectorsCount);
      if (skillBadge) skillBadge.textContent = String(skillsCount);

      for (const tabBtn of toolbar.querySelectorAll("[data-at-tab]")) {
        tabBtn.classList.toggle("ge-at-tab-active", tabBtn.dataset.atTab === activeAtTab);
      }
    }
  }

  function resizeAtMentionMenu(menuPane) {
    const targetWidth = Math.min(760, Math.round(window.innerWidth * 0.92));
    const promptEl = findPromptBarElement();
    const promptRect = promptEl ? promptEl.getBoundingClientRect() : null;
    const rect = menuPane.getBoundingClientRect();

    // Toujours afficher le menu @ AU-DESSUS de la barre de prompt
    const anchorTop = promptRect ? promptRect.top : rect.top;
    const spaceAbove = Math.max(260, anchorTop - 24);
    const targetMaxHeight = Math.min(Math.round(window.innerHeight * 0.78), spaceAbove);
    const bottomOffset = Math.max(16, window.innerHeight - anchorTop + 10);

    menuPane.style.setProperty("position", "fixed", "important");
    menuPane.style.setProperty("transform", "none", "important");
    menuPane.style.setProperty("margin", "0", "important");
    menuPane.style.setProperty("top", "auto", "important");
    menuPane.style.setProperty("bottom", `${Math.round(bottomOffset)}px`, "important");
    menuPane.style.setProperty("width", `${targetWidth}px`, "important");
    menuPane.style.setProperty("min-width", `${targetWidth}px`, "important");
    menuPane.style.setProperty("max-width", "92vw", "important");
    menuPane.style.setProperty("max-height", `${targetMaxHeight}px`, "important");

    // Recentrer horizontalement par rapport à la barre de prompt
    const centerX = promptRect
      ? promptRect.left + promptRect.width / 2
      : window.innerWidth / 2;
    const newLeft = Math.max(12, Math.min(window.innerWidth - targetWidth - 12, centerX - targetWidth / 2));
    menuPane.style.setProperty("left", `${Math.round(newLeft)}px`, "important");

    // Supprimer les max-height inline restrictifs sur les sous-conteneurs scrollables de Gemini
    const innerNodes = menuPane.querySelectorAll("*");
    for (const node of innerNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.id === AT_TOOLBAR_ID || node.closest(`#${AT_TOOLBAR_ID}`)) continue;
      const style = window.getComputedStyle(node);
      if (
        node.style.maxHeight ||
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        (style.maxHeight !== "none" && parseFloat(style.maxHeight) > 80 && parseFloat(style.maxHeight) < 650)
      ) {
        node.style.setProperty("max-height", `${targetMaxHeight - 8}px`, "important");
      }
    }
  }

  function injectAtToolbar(menuPane) {
    if (!menuPane) return;
    menuPane.classList.add("ge-at-enhanced-pane");
    resizeAtMentionMenu(menuPane);

    let toolbar = menuPane.querySelector(`#${AT_TOOLBAR_ID}`);
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = AT_TOOLBAR_ID;
      toolbar.className = "ge-at-toolbar";
      toolbar.innerHTML = `
        <div class="ge-at-tabs" role="tablist">
          <button type="button" class="ge-at-tab" data-at-tab="media">
            <span>Médias</span>
            <span class="ge-at-count" data-at-count="media">0</span>
          </button>
          <button type="button" class="ge-at-tab" data-at-tab="connectors">
            <span>Connecteurs</span>
            <span class="ge-at-count" data-at-count="connectors">0</span>
          </button>
          <button type="button" class="ge-at-tab" data-at-tab="skills">
            <span>Compétences</span>
            <span class="ge-at-count" data-at-count="skills">0</span>
          </button>
          <button type="button" class="ge-at-tab" data-at-tab="all">
            <span>Tout</span>
          </button>
        </div>
        <div class="ge-at-search-wrap">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input type="text" class="ge-at-search" placeholder="Filtrer..." value="${activeAtSearch}" />
        </div>
      `;

      for (const tabBtn of toolbar.querySelectorAll("[data-at-tab]")) {
        tabBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          activeAtTab = tabBtn.dataset.atTab;
          classifyAndFilterAtMenu(menuPane);
          const scrollable =
            menuPane.querySelector(".mat-mdc-menu-content, [role='listbox'], [role='menu']") ||
            menuPane.firstElementChild;
          if (scrollable) scrollable.scrollTop = 0;
        });
      }

      const searchInput = toolbar.querySelector(".ge-at-search");
      searchInput.addEventListener("input", (e) => {
        e.stopPropagation();
        activeAtSearch = searchInput.value.trim();
        classifyAndFilterAtMenu(menuPane);
      });
      searchInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
      });

      const host =
        menuPane.querySelector(".mat-mdc-menu-panel, [role='listbox'], [role='menu']") ||
        menuPane.firstElementChild ||
        menuPane;
      host.insertBefore(toolbar, host.firstChild);
      stopBubblePropagation(toolbar);
    }

    classifyAndFilterAtMenu(menuPane);
  }

  function scanForAtMentionMenu() {
    if (!isEnabled) return;
    const panes = document.querySelectorAll(".cdk-overlay-pane");
    let foundAtPane = null;
    for (const pane of panes) {
      if (isVisible(pane) && isAtMentionMenu(pane)) {
        foundAtPane = pane;
        break;
      }
    }

    if (foundAtPane) {
      injectAtToolbar(foundAtPane);
    } else {
      // Réinitialiser la recherche quand le menu @ se ferme
      activeAtSearch = "";
    }
  }

  // ============================================================================
  // Séparateurs fins entre chaque bouton du menu "+"
  // ============================================================================

  function isPlusMenu(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isModelSelectorMenu(el) || isAtMentionMenu(el)) return false;
    const text = (el.textContent || "").toLowerCase();
    return (
      (text.includes("importer des fichiers") || text.includes("upload files")) &&
      /plus d['’]importations|plus d['’]outils|more imports|more tools/i.test(text)
    );
  }

  function applyPlusMenuDividers(menuPane) {
    if (!menuPane) return;
    menuPane.classList.add("ge-plus-dividers-pane");

    for (const oldSep of menuPane.querySelectorAll(".ge-plus-line-sep")) {
      oldSep.classList.remove("ge-plus-line-sep");
    }

    const rowCandidates = [];
    const allEls = menuPane.querySelectorAll("*");
    for (const el of allEls) {
      if (!(el instanceof HTMLElement)) continue;
      const txt = (el.textContent || "").trim();
      if (!txt || txt.length > 65) continue;

      const r = el.getBoundingClientRect();
      if (r.height < 26 || r.height > 64 || r.width < 140) continue;

      const isInteractive =
        el.matches('button, [role="menuitem"], [role="button"], [role="option"], .mat-mdc-menu-item, .mat-mdc-list-item') ||
        window.getComputedStyle(el).cursor === "pointer";
      if (!isInteractive) continue;

      rowCandidates.push({ el, top: r.top, width: r.width });
    }

    rowCandidates.sort((a, b) => a.top - b.top || b.width - a.width);
    const visualRows = [];
    for (const cand of rowCandidates) {
      const alreadyHasRowAtY = visualRows.some((r) => Math.abs(r.top - cand.top) < 14);
      if (!alreadyHasRowAtY) {
        visualRows.push(cand);
      }
    }

    visualRows.forEach((row, idx) => {
      if (idx < visualRows.length - 1) {
        row.el.classList.add("ge-plus-line-sep");
      }
    });
  }

  // ============================================================================
  // Menu "+" à plat : le contenu de "Plus d'importations" / "Plus d'outils"
  // est affiché directement dans le menu, les deux sous-menus sont masqués.
  // Les copies déclenchent les vrais éléments de Gemini (ouverts de façon invisible).
  // ============================================================================

  const PLUS_SUBMENU_TRIGGER_RE = /plus d['’]importations|plus d['’]outils|more imports|more tools|more uploads/i;

  function getPlusSubmenuTriggers(mainMenu) {
    return Array.from(mainMenu.querySelectorAll(':scope > gem-menu-item[aria-haspopup="menu"]')).filter((t) =>
      PLUS_SUBMENU_TRIGGER_RE.test(t.textContent || "")
    );
  }

  // Le sous-menu est rendu dans un div.cdk-overlay-popover inséré juste après son déclencheur
  function getSubmenuItems(trigger) {
    for (let s = trigger.nextElementSibling; s && s.tagName !== "GEM-MENU-ITEM"; s = s.nextElementSibling) {
      const items = s.querySelectorAll(".submenu-gem-menu gem-menu-item");
      if (items.length) return Array.from(items);
    }
    return [];
  }

  async function openSubmenuSilently(trigger) {
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    for (let i = 0; i < 40; i++) {
      const items = getSubmenuItems(trigger);
      if (items.length) return items;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  function closeSubmenu(trigger) {
    if (trigger.isConnected && trigger.getAttribute("aria-expanded") === "true") trigger.click();
  }

  function getMenuItemLabel(item) {
    return (item.querySelector(".label")?.textContent || item.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function activateSubmenuItem(trigger, index, label) {
    const items = await openSubmenuSilently(trigger);
    const target =
      (items[index] && getMenuItemLabel(items[index]) === label ? items[index] : null) ||
      items.find((it) => getMenuItemLabel(it) === label);
    if (target) {
      target.click();
    } else {
      closeSubmenu(trigger);
    }
  }

  function createFlatMenuItem(original, trigger, index) {
    const clone = original.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("aria-describedby");
    clone.removeAttribute("cdk-describedby-host");
    clone.setAttribute("data-active", "false");
    clone.classList.add("ge-plus-flat-item");
    const label = getMenuItemLabel(original);
    clone.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateSubmenuItem(trigger, index, label);
    });
    return clone;
  }

  async function flattenPlusSubmenus(menuPane) {
    const mainMenu = menuPane.querySelector("gem-menu:not(.submenu-gem-menu)");
    if (!mainMenu || mainMenu.dataset.geFlattened) return false;
    const triggers = getPlusSubmenuTriggers(mainMenu);
    if (!triggers.length) return false;

    mainMenu.dataset.geFlattened = "1";
    for (const trigger of triggers) trigger.classList.add("ge-plus-hidden-trigger");

    // data-ge-flattened rend les sous-menus de ce menu invisibles (voir content.css)
    for (const trigger of triggers) {
      if (!trigger.isConnected) break;
      const items = await openSubmenuSilently(trigger);
      const clones = items.map((item, idx) => createFlatMenuItem(item, trigger, idx));
      closeSubmenu(trigger);
      if (clones.length) {
        trigger.before(...clones);
      } else {
        // Sous-menu illisible : on remet le déclencheur d'origine
        trigger.classList.remove("ge-plus-hidden-trigger");
      }
    }
    return true;
  }

  function expandPlusMenuNoScroll(menuPane) {
    if (!menuPane) return;
    const promptEl = findPromptBarElement();
    const promptRect = promptEl ? promptEl.getBoundingClientRect() : null;
    const targetMaxHeight = Math.min(
      Math.round(window.innerHeight * 0.88),
      Math.max(420, (promptRect ? promptRect.top : window.innerHeight) - 20)
    );

    menuPane.style.setProperty("max-height", `${targetMaxHeight}px`, "important");
    menuPane.style.setProperty("height", "auto", "important");

    if (promptRect) {
      const bottomOffset = Math.max(16, Math.round(window.innerHeight - promptRect.top + 10));
      menuPane.style.setProperty("position", "fixed", "important");
      menuPane.style.setProperty("transform", "none", "important");
      menuPane.style.setProperty("top", "auto", "important");
      menuPane.style.setProperty("bottom", `${bottomOffset}px`, "important");
      menuPane.style.setProperty("left", `${Math.max(12, Math.round(promptRect.left))}px`, "important");
    }

    const innerNodes = menuPane.querySelectorAll("*");
    for (const node of innerNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest(".submenu-gem-menu, .cdk-overlay-popover")) continue;
      const style = window.getComputedStyle(node);
      if (
        node.matches("gem-menu:not(.submenu-gem-menu)") ||
        node.style.maxHeight ||
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        (style.maxHeight !== "none" && parseFloat(style.maxHeight) > 80)
      ) {
        node.style.setProperty("max-height", `${targetMaxHeight - 8}px`, "important");
        node.style.setProperty("height", "auto", "important");
        node.style.setProperty("overflow-y", "visible", "important");
      }
    }
  }

  function scanForPlusMenu() {
    if (!isEnabled) return;
    const panes = document.querySelectorAll(".cdk-overlay-pane");
    for (const pane of panes) {
      if (!isVisible(pane)) continue;
      const hasPlusTriggers = !!pane.querySelector(
        'gem-menu:not(.submenu-gem-menu):not([data-ge-flattened]) > gem-menu-item[aria-haspopup="menu"]'
      );
      const isPlus = isPlusMenu(pane);
      if (hasPlusTriggers) {
        flattenPlusSubmenus(pane)
          .then((done) => {
            if (done && pane.isConnected) {
              expandPlusMenuNoScroll(pane);
              if (isPlus) applyPlusMenuDividers(pane);
            }
          })
          .catch((err) => console.error("[Gemini Extra] Erreur menu + à plat:", err));
      }
      if (isPlus) {
        expandPlusMenuNoScroll(pane);
        applyPlusMenuDividers(pane);
        requestAnimationFrame(() => {
          expandPlusMenuNoScroll(pane);
          applyPlusMenuDividers(pane);
        });
        break;
      }
    }
  }

  // ============================================================================
  // Sélecteur de modèle : "Niveau de réflexion" retiré du bas du menu. Après le
  // choix d'un modèle, le menu se rouvre et demande directement le niveau
  // (seulement si ce modèle en propose : "Auto" n'en a pas, par exemple).
  // ============================================================================

  const MODE_MENU_SELECTOR = 'gem-menu[data-test-id="gem-mode-menu"]';
  const THINK_STEP_ID = "gemini-extra-think-step";
  let isAskingThinkingLevel = false;
  let thinkStepMenu = null;

  function getModeMenuButton() {
    return document.querySelector('[data-test-id="bard-mode-menu-button"]');
  }

  function getModeMenu() {
    return document.querySelector(MODE_MENU_SELECTOR);
  }

  function getThinkingTrigger(modeMenu) {
    return modeMenu?.querySelector(':scope > gem-menu-item[value="thinking_level"]') || null;
  }

  // Le sous-menu des niveaux est déjà rendu (caché) dans le menu, via aria-controls
  function getThinkingLevelItems(trigger) {
    const submenu = trigger && document.getElementById(trigger.getAttribute("aria-controls"));
    return submenu ? Array.from(submenu.querySelectorAll("gem-menu-item")) : [];
  }

  async function waitFor(check, timeoutMs) {
    for (let waited = 0; waited <= timeoutMs; waited += 25) {
      const value = check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  // Gemini réutilise le même élément de menu d'une ouverture à l'autre : l'étape
  // "niveau" doit être retirée dès que le menu se ferme
  function removeThinkingLevelStep() {
    if (!thinkStepMenu) return;
    thinkStepMenu.querySelector(`#${THINK_STEP_ID}`)?.remove();
    thinkStepMenu.classList.remove("ge-think-step-active");
    thinkStepMenu = null;
  }

  async function removeThinkingLevelStepOnClose(modeMenu) {
    while (thinkStepMenu === modeMenu && modeMenu.isConnected) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (thinkStepMenu === modeMenu) removeThinkingLevelStep();
  }

  async function applyThinkingLevel(label) {
    const modeMenu = getModeMenu();
    const trigger = getThinkingTrigger(modeMenu);
    if (!trigger) return;
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    const target = getThinkingLevelItems(trigger).find((it) => getMenuItemLabel(it) === label);
    if (target) target.click();
  }

  function showThinkingLevelStep(modeMenu, trigger) {
    modeMenu.querySelector(`#${THINK_STEP_ID}`)?.remove();
    const step = document.createElement("div");
    step.id = THINK_STEP_ID;

    const header = document.createElement("div");
    header.className = "ge-think-header";
    header.textContent = getMenuItemLabel(trigger) || "Niveau de réflexion";
    step.appendChild(header);

    for (const level of getThinkingLevelItems(trigger)) {
      const clone = level.cloneNode(true);
      clone.removeAttribute("id");
      clone.setAttribute("data-active", "false");
      const label = getMenuItemLabel(level);
      clone.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyThinkingLevel(label);
      });
      step.appendChild(clone);
    }

    // Le focus doit rester dans le menu avant de masquer ses éléments, sinon Gemini le ferme
    step.tabIndex = -1;
    modeMenu.prepend(step);
    step.focus({ preventScroll: true });
    modeMenu.classList.add("ge-think-step-active");
    thinkStepMenu = modeMenu;
    removeThinkingLevelStepOnClose(modeMenu);
  }

  async function askThinkingLevelAfterModelPick() {
    if (isAskingThinkingLevel) return;
    isAskingThinkingLevel = true;
    const root = document.documentElement;
    try {
      const btn = getModeMenuButton();
      if (!btn) return;
      // Attendre que Gemini ferme le menu après la sélection du modèle
      const closed = await waitFor(() => !getModeMenu() && btn.getAttribute("aria-expanded") !== "true", 1500);
      if (!closed) return;

      root.classList.add("ge-think-pending");
      btn.click();
      const modeMenu = await waitFor(getModeMenu, 1500);
      if (!modeMenu) return;

      const trigger = getThinkingTrigger(modeMenu);
      if (trigger && getThinkingLevelItems(trigger).length) {
        showThinkingLevelStep(modeMenu, trigger);
      } else if (btn.getAttribute("aria-expanded") === "true") {
        // Ce modèle n'a pas de niveau de réflexion : on referme
        btn.click();
      }
    } finally {
      root.classList.remove("ge-think-pending");
      isAskingThinkingLevel = false;
    }
  }

  function handleModelPickClick(e) {
    if (!isEnabled || !e.isTrusted) return;
    if (e.target instanceof Element && e.target.closest('[data-test-id="bard-mode-menu-button"]')) {
      removeThinkingLevelStep();
      return;
    }
    const item = e.target instanceof Element ? e.target.closest("gem-menu-item[data-mode-id]") : null;
    if (!item || !item.closest(MODE_MENU_SELECTOR)) return;
    // Les modèles verrouillés (offre payante) gardent leur comportement d'origine
    if (/^upsell/i.test(item.getAttribute("data-mode-id") || "")) return;
    askThinkingLevelAfterModelPick().catch((err) =>
      console.error("[Gemini Extra] Erreur niveau de réflexion:", err)
    );
  }

  // ============================================================================
  // Barre latérale gauche : "Plus" masqué, Personnaliser / Vidéos / Gems affichés
  // directement. Le menu "Plus" de Gemini s'ouvre au survol : les copies l'ouvrent
  // de façon invisible et cliquent le vrai lien (navigation interne de Gemini).
  // ============================================================================

  let sidebarMoreEntries = null; // [{ value, label, icon, href }] lus dans le vrai menu
  let isFlatteningSidebarMore = false;
  let sidebarObserver = null;
  let observedSidebarEl = null;
  let sidebarSyncRaf = null;

  function findSidebarMoreHost() {
    return (
      document.querySelector('gem-nav-list-item[data-test-id="overflow-side-nav-entry-button"]') ||
      document.querySelector('button[aria-controls="p42-overflow-menu"]')?.closest("gem-nav-list-item") ||
      null
    );
  }

  function getSidebarMoreMenuItems(wrap) {
    return Array.from(wrap.querySelectorAll(":scope > .cdk-overlay-popover gem-menu-item"));
  }

  function fireSidebarHover(host, types) {
    const btn = host.querySelector("button") || host;
    for (const type of types) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      btn.dispatchEvent(new Ctor(type, { bubbles: true }));
    }
  }

  async function openSidebarMoreSilently(host) {
    const wrap = host.parentElement;
    if (!getSidebarMoreMenuItems(wrap).length) {
      fireSidebarHover(host, ["pointerover", "pointerenter", "mouseover", "mouseenter"]);
    }
    for (let i = 0; i < 40; i++) {
      const items = getSidebarMoreMenuItems(wrap);
      if (items.length) return items;
      await new Promise((r) => setTimeout(r, 25));
    }
    return [];
  }

  // Un "quitter le survol" envoyé pendant l'ouverture est ignoré par Gemini : on réessaie
  function closeSidebarMoreSilently(host, tries = 4) {
    if (!host.isConnected || !getSidebarMoreMenuItems(host.parentElement).length) return;
    fireSidebarHover(host, ["pointerout", "pointerleave", "mouseout", "mouseleave"]);
    if (tries > 1) setTimeout(() => closeSidebarMoreSilently(host, tries - 1), 400);
  }

  function readSidebarMoreEntry(item) {
    const icon = item.querySelector("mat-icon");
    return {
      value: item.getAttribute("value") || "",
      label: (item.querySelector(".label")?.textContent || item.textContent || "").replace(/\s+/g, " ").trim(),
      icon: item.getAttribute("leadingicon") || icon?.getAttribute("fonticon") || icon?.getAttribute("data-mat-icon-name") || "",
      href: item.querySelector("a[href]")?.getAttribute("href") || ""
    };
  }

  function stripAccountPrefix(path) {
    return (path || "").replace(/^\/u\/\d+(?=\/|$)/, "") || "/";
  }

  function isSidebarEntryActive(entry) {
    if (!entry.href) return false;
    const target = stripAccountPrefix(new URL(entry.href, location.origin).pathname);
    const current = stripAccountPrefix(location.pathname);
    // "/gems/view" doit aussi rester actif sur "/gems/..." (édition d'un Gem, etc.)
    const base = target.split("/").slice(0, 2).join("/") || target;
    return current === target || current.startsWith(base + "/") || current === base;
  }

  function updateSidebarMoreActiveState() {
    for (const row of document.querySelectorAll(".ge-sidebar-more-item")) {
      const link = row.querySelector("a");
      if (!link || !row._geEntry) continue;
      const active = isSidebarEntryActive(row._geEntry);
      link.classList.toggle("is-active", active);
      link.classList.toggle("mdc-list-item--activated", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  async function activateSidebarMoreEntry(host, entry) {
    if (!host.isConnected) host = findSidebarMoreHost();
    const items = host ? await openSidebarMoreSilently(host) : [];
    const target =
      items.find((it) => entry.value && it.getAttribute("value") === entry.value) ||
      items.find((it) => readSidebarMoreEntry(it).label === entry.label);
    const link = target?.querySelector("a[href]");
    if (link) {
      link.click();
    } else {
      if (host) closeSidebarMoreSilently(host);
      if (entry.href) location.assign(entry.href);
    }
  }

  function buildSidebarMoreRow(templateRow, entry, host) {
    const row = templateRow.cloneNode(true);
    row._geEntry = entry;
    row.classList.add("ge-sidebar-more-item");
    row.setAttribute("data-test-id", `ge-sidebar-more-${entry.value || entry.label}`);

    const link = row.querySelector("a");
    if (link) {
      if (entry.href) link.setAttribute("href", entry.href);
      else link.removeAttribute("href");
      link.setAttribute("aria-label", entry.label);
      link.classList.remove("is-active", "mdc-list-item--activated", "cdk-focused", "cdk-mouse-focused");
      link.removeAttribute("aria-current");
      link.removeAttribute("aria-describedby");
    }

    const icon = row.querySelector("mat-icon");
    if (icon && entry.icon) {
      icon.setAttribute("fonticon", entry.icon);
      icon.setAttribute("data-mat-icon-name", entry.icon);
    }

    const title = row.querySelector(".title-text");
    if (title) title.textContent = entry.label;

    row.addEventListener("click", (e) => {
      // Ctrl/Cmd/Maj/clic molette : laisser le navigateur ouvrir le lien normalement
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      activateSidebarMoreEntry(host, entry);
    });
    return row;
  }

  function insertSidebarMoreRows(host, entries) {
    const wrap = host.parentElement;
    const templateRow = wrap.parentElement?.querySelector(
      ":scope > gem-nav-list-item:not(.ge-sidebar-more-item) a[href]"
    )?.closest("gem-nav-list-item");
    if (!templateRow) return false;
    for (const old of wrap.parentElement.querySelectorAll(":scope > .ge-sidebar-more-item")) old.remove();
    wrap.before(...entries.map((entry) => buildSidebarMoreRow(templateRow, entry, host)));
    host.classList.add("ge-sidebar-more-hidden");
    updateSidebarMoreActiveState();
    return true;
  }

  async function flattenSidebarMoreMenu() {
    if (!isEnabled || isFlatteningSidebarMore) return;
    const host = findSidebarMoreHost();
    const wrap = host?.parentElement;
    if (!host || !wrap) return;

    if (wrap.dataset.geSideFlattened) {
      updateSidebarMoreActiveState();
      return;
    }
    // data-ge-side-flattened rend le vrai menu "Plus" invisible (voir content.css)
    wrap.dataset.geSideFlattened = "1";

    if (sidebarMoreEntries && insertSidebarMoreRows(host, sidebarMoreEntries)) return;

    isFlatteningSidebarMore = true;
    host.classList.add("ge-sidebar-more-hidden");
    try {
      const items = await openSidebarMoreSilently(host);
      const entries = items.map(readSidebarMoreEntry).filter((e) => e.label);
      closeSidebarMoreSilently(host);
      if (entries.length && host.isConnected && insertSidebarMoreRows(host, entries)) {
        sidebarMoreEntries = entries;
      } else {
        // Menu illisible : on remet le "Plus" d'origine
        host.classList.remove("ge-sidebar-more-hidden");
        delete wrap.dataset.geSideFlattened;
      }
    } finally {
      isFlatteningSidebarMore = false;
    }
  }

  function scheduleSidebarSync() {
    if (sidebarSyncRaf) return;
    sidebarSyncRaf = requestAnimationFrame(() => {
      sidebarSyncRaf = null;
      flattenSidebarMoreMenu().catch((err) => console.error("[Gemini Extra] Erreur menu Plus sidebar:", err));
    });
  }

  // Le contenu de la barre latérale est recréé à chaque ouverture : on observe le tiroir
  function attachSidebarObserver() {
    const sidenav = document.querySelector("mat-sidenav") || document.querySelector("side-navigation-v2");
    if (!sidenav || (sidebarObserver && observedSidebarEl === sidenav)) return;
    if (sidebarObserver) sidebarObserver.disconnect();
    sidebarObserver = new MutationObserver(() => {
      if (isEnabled) scheduleSidebarSync();
    });
    // aria-current : suivre le changement de page pour surligner l'entrée active
    sidebarObserver.observe(sidenav, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current"]
    });
    observedSidebarEl = sidenav;
  }

  function detachSidebarObserver() {
    if (sidebarObserver) sidebarObserver.disconnect();
    sidebarObserver = null;
    observedSidebarEl = null;
    if (sidebarSyncRaf) cancelAnimationFrame(sidebarSyncRaf);
    sidebarSyncRaf = null;
  }

  function removeSidebarMoreRows() {
    for (const row of document.querySelectorAll(".ge-sidebar-more-item")) row.remove();
    for (const host of document.querySelectorAll(".ge-sidebar-more-hidden")) {
      host.classList.remove("ge-sidebar-more-hidden");
      if (host.parentElement) delete host.parentElement.dataset.geSideFlattened;
    }
  }

  function scheduleOverlayScan(delay = 40) {
    if (!isEnabled || scanDebounceTimer) return;
    scanDebounceTimer = setTimeout(() => {
      scanDebounceTimer = null;
      scanOverlaysOnly();
    }, delay);
  }

  function attachOverlayObserver() {
    const overlayContainer = document.querySelector(".cdk-overlay-container");
    if (!overlayContainer) return false;
    if (overlayObserver && observedOverlayContainer === overlayContainer) return true;

    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }

    overlayObserver = new MutationObserver(() => {
      if (!isEnabled) return;
      scheduleOverlayScan(30);
    });
    // Observer uniquement .cdk-overlay-container (quasi zéro mutation en dehors des menus !)
    overlayObserver.observe(overlayContainer, {
      childList: true,
      subtree: true
    });
    observedOverlayContainer = overlayContainer;
    return true;
  }

  function startDomObserver() {
    if (!attachOverlayObserver() && !bodyBootObserver) {
      // Attendre uniquement l'apparition de .cdk-overlay-container (sans subtree sur document.body)
      bodyBootObserver = new MutationObserver(() => {
        if (attachOverlayObserver() && bodyBootObserver) {
          bodyBootObserver.disconnect();
          bodyBootObserver = null;
        }
      });
      bodyBootObserver.observe(document.body, { childList: true });
    }

    if (!layoutWatchTimer) {
      // Vérification ultra-légère toutes les 1.5s pour montage widgets / route SPA
      layoutWatchTimer = setInterval(ensureWidgetsMounted, 1500);
    }

    document.addEventListener("click", handleDocumentClickScan, true);
    document.addEventListener("click", handleModelPickClick, true);
    window.addEventListener("resize", positionQuotaBubble);
  }

  function handleDocumentClickScan(e) {
    if (!isEnabled) return;
    const flyout = document.getElementById(FLYOUT_ID);
    const bubble = document.getElementById(BUBBLE_ID);
    if (
      flyout &&
      !flyout.hidden &&
      flyout.dataset.anchor === "bubble" &&
      !flyout.contains(e.target) &&
      (!bubble || !bubble.contains(e.target))
    ) {
      hideFlyoutNow();
    }
    const tokenPop = document.getElementById(TOKEN_POPOVER_ID);
    const tokenWidget = document.getElementById(TOKEN_WIDGET_ID);
    if (
      tokenPop &&
      !tokenPop.hidden &&
      !tokenPop.contains(e.target) &&
      (!tokenWidget || !tokenWidget.contains(e.target))
    ) {
      tokenPop.hidden = true;
    }
    setTimeout(scanOverlaysOnly, 60);
    setTimeout(scanOverlaysOnly, 220);
    setTimeout(scanOverlaysOnly, 420);
  }

  function stopDomObserver() {
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
    observedOverlayContainer = null;
    detachSidebarObserver();
    if (bodyBootObserver) {
      bodyBootObserver.disconnect();
      bodyBootObserver = null;
    }
    if (layoutWatchTimer) {
      clearInterval(layoutWatchTimer);
      layoutWatchTimer = null;
    }
    if (scanDebounceTimer) {
      clearTimeout(scanDebounceTimer);
      scanDebounceTimer = null;
    }
    if (pointerTrackRaf) {
      cancelAnimationFrame(pointerTrackRaf);
      pointerTrackRaf = null;
    }
    if (promptResizeObserver) {
      promptResizeObserver.disconnect();
      promptResizeObserver = null;
    }
    if (tokenTickTimer) {
      clearInterval(tokenTickTimer);
      tokenTickTimer = null;
    }
    observedPromptEl = null;
    boundTextareaEl = null;
    document.removeEventListener("click", handleDocumentClickScan, true);
    document.removeEventListener("click", handleModelPickClick, true);
    window.removeEventListener("resize", positionQuotaBubble);
  }

  function removeUI() {
    const item = document.getElementById(MENU_ITEM_ID);
    if (item) item.remove();
    removeSidebarMoreRows();
    removeThinkingLevelStep();
    const flyout = document.getElementById(FLYOUT_ID);
    if (flyout) flyout.remove();
    const bubble = document.getElementById(BUBBLE_ID);
    if (bubble) bubble.remove();
    const tokenWidget = document.getElementById(TOKEN_WIDGET_ID);
    if (tokenWidget) tokenWidget.remove();
    const tokenPopover = document.getElementById(TOKEN_POPOVER_ID);
    if (tokenPopover) tokenPopover.remove();
    activeMenuPanel = null;
  }

  // ============================================================================
  // Prédicteur de tokens avancé (Tokenizer réaliste, Thinking vs Réponse, Historique)
  // ============================================================================

  /**
   * Estime les tokens au plus proche du tokenizer SentencePiece de Gemini :
   * - Gère les mots accentués (FR/EU), camelCase, snake_case, nombres,
   *   indentations de code, URLs, ponctuation/symboles et émojis.
   */
  function estimateTokensDetailed(text) {
    if (!text) return { tokens: 0, words: 0, chars: 0 };
    const normalized = text.replace(/\r\n/g, "\n").replace(/\u200B/g, "");
    const trimmed = normalized.trim();
    if (!trimmed) return { tokens: 0, words: 0, chars: 0 };

    let tokens = 0;
    let words = 0;

    // Découpage en segments : indentations multi-espaces, sauts de ligne, mots (avec camelCase), nombres, symboles
    const segments = normalized.match(/[ ]{2,}|\t+|\n+|[\p{L}\p{M}]+|\d+|[^\s\p{L}\p{M}\d]+/gu);
    if (!segments) return { tokens: 0, words: 0, chars: trimmed.length };

    for (const seg of segments) {
      if (seg[0] === "\n") {
        tokens += seg.length;
      } else if (seg[0] === " " || seg[0] === "\t") {
        // Indentation de code : ~4 espaces ou 1 tab = 1 token
        tokens += seg[0] === "\t" ? seg.length : Math.ceil(seg.length / 4);
      } else if (/^\d+$/.test(seg)) {
        // Chiffres : SentencePiece découpe souvent par groupes de 1 à 3 chiffres
        tokens += Math.ceil(seg.length / 2.2);
      } else if (/^[\p{L}\p{M}]+$/u.test(seg)) {
        words += 1;
        // Découper le camelCase (ex: getElementById -> get, Element, By, Id)
        const camelParts = seg.split(/(?=[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ])/);
        for (const part of camelParts) {
          if (!part) continue;
          const nonAsciiCount = (part.match(/[^\x00-\x7F]/g) || []).length;
          // Les mots accentués ou longs se découpent légèrement plus finement
          const effectiveLen = part.length + nonAsciiCount * 0.35;
          if (effectiveLen <= 4.2) {
            tokens += 1;
          } else {
            tokens += Math.ceil(effectiveLen / 3.7);
          }
        }
      } else {
        // Ponctuation, opérateurs de code, émojis
        const emojiMatches = seg.match(/\p{Extended_Pictographic}/gu);
        if (emojiMatches) {
          tokens += emojiMatches.length * 2 + Math.max(0, seg.length - emojiMatches.length);
        } else {
          tokens += Math.ceil(seg.length / 1.4);
        }
      }
    }

    return {
      tokens: Math.max(1, tokens),
      words,
      chars: trimmed.length
    };
  }

  function estimateTokens(text) {
    return estimateTokensDetailed(text).tokens;
  }

  function countDraftAttachments() {
    const inputContainer = findPromptBarElement();
    if (!inputContainer) return 0;
    const attachments = inputContainer.querySelectorAll(
      'img[src^="blob:"], img[src^="data:"], .file-preview, [data-test-id*="file"], [data-test-id*="image-preview"]'
    );
    return attachments.length;
  }

  function formatCompactTokenCount(n) {
    const val = Math.max(0, Math.round(n || 0));
    if (val >= 100000) return `${Math.round(val / 1000)}k`;
    if (val >= 1000) return `${(val / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return String(val);
  }

  function getPromptInputElement() {
    const rich = document.querySelector("rich-textarea");
    if (rich) {
      const editable = rich.querySelector('[contenteditable="true"], textarea, .ql-editor');
      if (editable) return editable;
      return rich;
    }
    return document.querySelector('textarea[aria-label], [contenteditable="true"][role="textbox"]');
  }

  function persistCurrentTokenState(immediate = false) {
    const path = window.location.pathname;
    const snapshot = {
      ...tokenState,
      isGenerating: false,
      updatedAt: Date.now()
    };
    conversationStates.set(path, snapshot);

    const doSave = async () => {
      try {
        const { tokenStatesByPath = {} } = await browser.storage.local.get("tokenStatesByPath");
        tokenStatesByPath[path] = snapshot;

        // Garder au maximum les 50 conversations les plus récentes
        const entries = Object.entries(tokenStatesByPath);
        if (entries.length > 50) {
          entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
          const trimmed = Object.fromEntries(entries.slice(0, 50));
          await browser.storage.local.set({ tokenStatesByPath: trimmed });
        } else {
          await browser.storage.local.set({ tokenStatesByPath });
        }
      } catch (err) {
        console.warn("[Gemini Extra] Erreur sauvegarde tokens:", err);
      }
    };

    if (immediate) {
      if (persistTokenTimer) {
        clearTimeout(persistTokenTimer);
        persistTokenTimer = null;
      }
      doSave();
    } else {
      if (persistTokenTimer) clearTimeout(persistTokenTimer);
      persistTokenTimer = setTimeout(doSave, 300);
    }
  }

  function deduplicateTopElements(elements) {
    const set = new Set(elements);
    return elements.filter((el) => {
      let parent = el.parentElement;
      while (parent) {
        if (set.has(parent)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function getUserQueryElements() {
    const raw = Array.from(
      document.querySelectorAll(
        'user-query, [data-message-author-role="user"], .user-query-container, .user-query-bubble-with-background, .query-text'
      )
    );
    return deduplicateTopElements(raw).filter((el) => (el.textContent || "").trim().length > 0);
  }

  function getModelResponseElements() {
    const raw = Array.from(
      document.querySelectorAll(
        'model-response, response-container, .response-container, [data-message-author-role="model"], .model-response-text, message-content, .markdown-main-panel, .markdown'
      )
    );
    return deduplicateTopElements(raw).filter((el) => {
      // Exclure le champ de saisie si jamais il a une classe .markdown
      if (el.closest("rich-textarea, .input-area-container, .input-area")) return false;
      return (el.textContent || "").trim().length > 0;
    });
  }

  /**
   * Extrait séparément le texte de réflexion (si présent) et le texte de réponse réelle
   * sans clonage DOM (zéro allocation).
   */
  function extractModelResponseParts(responseEl) {
    if (!responseEl) return { thoughtsText: "", responseText: "" };

    let thoughtsText = "";
    const thoughtSelectors = [
      "model-thoughts",
      ".thoughts-container",
      ".model-thoughts",
      '[data-test-id*="thought" i]',
      ".thinking-process"
    ];
    const thoughtEls = responseEl.querySelectorAll(thoughtSelectors.join(", "));
    for (const tEl of thoughtEls) {
      thoughtsText += " " + (tEl.textContent || "");
    }
    thoughtsText = thoughtsText
      .replace(/afficher le raisonnement|masquer le raisonnement|show thinking|hide thinking/gi, "")
      .trim();

    const contentEl =
      responseEl.querySelector("message-content .markdown, .model-response-text .markdown, .markdown-main-panel, .markdown, message-content") ||
      responseEl;

    const responseText = contentEl ? (contentEl.textContent || "").trim() : "";
    return { thoughtsText, responseText };
  }

  function isGeminiGenerating() {
    return Boolean(
      document.querySelector(
        'button[aria-label*="Arrêter" i], button[aria-label*="Stop" i], mat-icon[data-mat-icon-name="stop"], mat-icon[fonticon="stop"], .stop-icon, .stop-button'
      )
    );
  }

  /**
   * Scanne les échanges présents dans la conversation ouverte.
   * Si l'état a été restauré depuis storage.local et que le nombre de messages n'a pas changé,
   * on conserve les valeurs exactes (dont les temps de réflexion mesurés en direct).
   */
  function scanExistingConversationTokens() {
    if (tokenState.isGenerating) return;

    const userEls = getUserQueryElements();
    const modelEls = getModelResponseElements();
    if (userEls.length === 0 && modelEls.length === 0) return;

    // Déjà synchronisé avec ce nombre exact de messages
    if (
      tokenState.historyScanned &&
      tokenState.knownUserCount === userEls.length &&
      tokenState.knownModelCount === modelEls.length
    ) {
      return;
    }

    // Si on a déjà des données sauvegardées pour ce nombre exact de messages, on ne les écrase pas
    if (
      tokenState.completedTotalTokens > 0 &&
      tokenState.knownUserCount === userEls.length &&
      tokenState.knownModelCount === modelEls.length
    ) {
      tokenState.historyScanned = true;
      updateTokenWidgetUI();
      return;
    }

    let total = 0;
    for (const uEl of userEls) {
      const txt = (uEl.textContent || "").trim();
      total += estimateTokens(txt);
    }

    let lastExchangeIn = 0;
    if (userEls.length > 0) {
      lastExchangeIn = estimateTokens((userEls[userEls.length - 1].textContent || "").trim());
    }

    let lastExchangeOut = 0;
    let lastExchangeRespTok = 0;
    let lastExchangeRespWords = 0;
    let lastExchangeThinkTok = 0;

    for (const mEl of modelEls) {
      const { thoughtsText, responseText } = extractModelResponseParts(mEl);
      const thinkTok = thoughtsText ? estimateTokens(thoughtsText) : 0;
      const respDetail = estimateTokensDetailed(responseText);
      const msgOut = thinkTok + respDetail.tokens;
      total += msgOut;
      lastExchangeOut = msgOut;
      lastExchangeRespTok = respDetail.tokens;
      lastExchangeRespWords = respDetail.words;
      lastExchangeThinkTok = thinkTok;
    }

    if (total > 0) {
      tokenState.completedTotalTokens = Math.max(tokenState.completedTotalTokens, total);
      tokenState.exchangeCount = Math.max(userEls.length, modelEls.length);
      tokenState.knownUserCount = userEls.length;
      tokenState.knownModelCount = modelEls.length;
      if (tokenState.exchangeInputTokens === 0 && lastExchangeIn > 0) {
        tokenState.exchangeInputTokens = lastExchangeIn;
      }
      if (tokenState.exchangeOutputTokens === 0 && lastExchangeOut > 0) {
        tokenState.exchangeOutputTokens = lastExchangeOut;
        tokenState.exchangeResponseTokens = lastExchangeRespTok;
        tokenState.exchangeResponseWords = lastExchangeRespWords;
        tokenState.exchangeThinkingTokens = lastExchangeThinkTok;
        tokenState.thinkingSource = lastExchangeThinkTok > 0 ? "dom" : "none";
      }
      tokenState.historyScanned = true;
      updateTokenWidgetUI();
      persistCurrentTokenState(false);
    }
  }

  function syncConversationRoute() {
    const currentPath = window.location.pathname;
    if (currentPath !== lastKnownPath) {
      const prevPath = lastKnownPath;
      conversationStates.set(prevPath, { ...tokenState, isGenerating: false });
      lastKnownPath = currentPath;
      const restored = conversationStates.get(currentPath);
      tokenState = restored ? { ...restored } : createEmptyTokenState();
      updateTokenWidgetUI();
      setTimeout(scanExistingConversationTokens, 450);

      // Si on a changé de compte Google (/u/0 -> /u/1), recharger le quota de ce compte
      const prevAccountMatch = prevPath.match(/^\/u\/(\d+)(?:\/|$)/);
      const prevAccount = prevAccountMatch ? `u_${prevAccountMatch[1]}` : "u_0";
      const nextAccount = getAccountKey();
      if (prevAccount !== nextAccount) {
        browser.storage.local.get("quotaByAccount").then(({ quotaByAccount = {} }) => {
          if (quotaByAccount[nextAccount]) {
            currentQuota = quotaByAccount[nextAccount];
          } else {
            currentQuota = {
              current: { percent: null, resetText: "Chargement...", rawPercentText: "--" },
              weekly: { percent: null, resetText: "Chargement...", rawPercentText: "--" },
              updatedAt: null,
              error: null
            };
          }
          updateFlyoutContent();
          fetchUsageViaIframe(true);
        }).catch(() => {});
      }
    }
  }

  function startExchangeFromSend(textOverride) {
    const inputEl = getPromptInputElement();
    const rawText = typeof textOverride === "string" ? textOverride : (inputEl?.innerText || inputEl?.value || "");
    const attachmentTokens = countDraftAttachments() * 258;
    const sentTokens = (estimateTokens(rawText) || tokenState.draftInputTokens) + attachmentTokens;
    if (sentTokens <= 0 && !tokenState.lastDraftText.trim()) return;

    if (tokenState.isGenerating) {
      tokenState.completedTotalTokens +=
        tokenState.exchangeInputTokens + tokenState.exchangeOutputTokens;
      tokenState.exchangeCount += 1;
    }

    tokenState.exchangeInputTokens = sentTokens;
    tokenState.exchangeThinkingTokens = 0;
    tokenState.exchangeResponseTokens = 0;
    tokenState.exchangeResponseWords = 0;
    tokenState.exchangeOutputTokens = 0;
    tokenState.thinkingSource = "none";
    tokenState.thinkingSeconds = 0;
    tokenState.draftInputTokens = 0;
    tokenState.draftWords = 0;
    tokenState.draftChars = 0;
    tokenState.draftAttachments = 0;
    tokenState.lastDraftText = "";
    tokenState.historyScanned = true;
    tokenState.isGenerating = true;
    tokenState.sendTimestamp = Date.now();
    tokenState.firstResponseTimestamp = 0;
    tokenState.userCountBeforeSend = getUserQueryElements().length;
    tokenState.responseCountBeforeSend = getModelResponseElements().length;
    tokenState.lastResponseText = "";
    tokenState.lastResponseChangeAt = Date.now();

    updateTokenWidgetUI();
    ensureTokenTickerRunning();
  }

  function ensureTokenTickerRunning() {
    if (tokenTickTimer) return;
    tokenTickTimer = setInterval(() => {
      if (!isEnabled) return;
      syncConversationRoute();

      if (!tokenState.isGenerating) {
        clearInterval(tokenTickTimer);
        tokenTickTimer = null;
        return;
      }

      const now = Date.now();
      const responses = getModelResponseElements();
      const hasNewResponse = responses.length > tokenState.responseCountBeforeSend;
      const latestEl = hasNewResponse ? responses[responses.length - 1] : null;
      const { thoughtsText, responseText } = extractModelResponseParts(latestEl);

      if (responseText && !tokenState.firstResponseTimestamp) {
        tokenState.firstResponseTimestamp = now;
      }

      const combinedSignature = `${thoughtsText.length}:${responseText}`;
      if (combinedSignature !== tokenState.lastResponseText) {
        tokenState.lastResponseText = combinedSignature;
        tokenState.lastResponseChangeAt = now;
      }

      const thinkingMs = tokenState.firstResponseTimestamp
        ? tokenState.firstResponseTimestamp - tokenState.sendTimestamp
        : now - tokenState.sendTimestamp;
      tokenState.thinkingSeconds = Math.max(0, thinkingMs / 1000);

      // Si le vrai texte de réflexion est dans le DOM, on le compte directement ; sinon estimation par temps d'attente
      let thinkingTokens = 0;
      if (thoughtsText.length > 0) {
        thinkingTokens = estimateTokens(thoughtsText);
        tokenState.thinkingSource = "dom";
      } else if (tokenState.thinkingSeconds >= 0.4) {
        thinkingTokens = Math.round(tokenState.thinkingSeconds * 45);
        tokenState.thinkingSource = "timer";
      } else {
        tokenState.thinkingSource = "none";
      }

      const respDetail = estimateTokensDetailed(responseText);
      tokenState.exchangeThinkingTokens = thinkingTokens;
      tokenState.exchangeResponseTokens = respDetail.tokens;
      tokenState.exchangeResponseWords = respDetail.words;
      tokenState.exchangeOutputTokens = thinkingTokens + respDetail.tokens;

      const generatingFlag = isGeminiGenerating();
      const elapsedSinceSend = now - tokenState.sendTimestamp;
      const idleSinceLastChange = now - tokenState.lastResponseChangeAt;
      const hasNewUserMsg = getUserQueryElements().length > tokenState.userCountBeforeSend;

      // Garde-fou anti-faux-positif : si après 3.5s l'IA ne génère pas et aucun nouveau message n'est apparu, annuler
      if (!generatingFlag && !hasNewResponse && !hasNewUserMsg && elapsedSinceSend > 3500) {
        tokenState.isGenerating = false;
        tokenState.exchangeInputTokens = 0;
        tokenState.exchangeThinkingTokens = 0;
        tokenState.exchangeResponseTokens = 0;
        tokenState.exchangeResponseWords = 0;
        tokenState.exchangeOutputTokens = 0;
        tokenState.thinkingSource = "none";
        tokenState.thinkingSeconds = 0;
        clearInterval(tokenTickTimer);
        tokenTickTimer = null;
        handleDraftInputChange();
        return;
      }

      if (
        (!generatingFlag && hasNewResponse && (responseText.length > 0 || thoughtsText.length > 0) && idleSinceLastChange > 1100) ||
        elapsedSinceSend > 180000
      ) {
        tokenState.completedTotalTokens +=
          tokenState.exchangeInputTokens + tokenState.exchangeOutputTokens;
        tokenState.exchangeCount += 1;
        tokenState.knownUserCount = getUserQueryElements().length;
        tokenState.knownModelCount = responses.length;
        tokenState.isGenerating = false;
        clearInterval(tokenTickTimer);
        tokenTickTimer = null;
        persistCurrentTokenState(true);
      }

      updateTokenWidgetUI();
    }, 500);
  }

  function checkAndHandleAtShortcuts(inputEl) {
    if (isReplacingAtTrigger || !inputEl) return;

    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return;

    const anchorNode = sel.anchorNode;
    if (!anchorNode || !inputEl.contains(anchorNode)) return;

    const offset = sel.anchorOffset;
    if (anchorNode.nodeType !== Node.TEXT_NODE || offset < 1) return;

    const text = anchorNode.textContent || "";
    const triggerChar = text[offset - 1];
    if (triggerChar !== "@" && triggerChar !== "/" && triggerChar !== "*") return;

    // Vérifier que le caractère est au début ou précédé d'un espace / saut de ligne
    const prevChar = offset >= 2 ? text[offset - 2] : "";
    const isStartOrAfterSpace = offset === 1 || /[\s\u00A0]/.test(prevChar);
    if (!isStartOrAfterSpace) return;

    if (triggerChar === "@") {
      activeAtTab = "connectors";
      const existingPane = document.querySelector(".ge-at-enhanced-pane");
      if (existingPane) classifyAndFilterAtMenu(existingPane);
      return;
    }

    activeAtTab = triggerChar === "/" ? "skills" : "media";

    // Remplacer "/" ou "*" par "@" pour déclencher le menu natif de Gemini
    isReplacingAtTrigger = true;
    try {
      const range = document.createRange();
      range.setStart(anchorNode, offset - 1);
      range.setEnd(anchorNode, offset);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, "@");
    } catch (err) {
      console.warn("[Gemini Extra] Erreur remplacement raccourci:", err);
    } finally {
      setTimeout(() => {
        isReplacingAtTrigger = false;
      }, 30);
    }
  }

  function handleDraftInputChange(e) {
    if (!isEnabled) return;
    syncConversationRoute();

    const inputEl = getPromptInputElement();
    if (!inputEl) return;

    if (!e || e.type === "input") {
      checkAndHandleAtShortcuts(inputEl);
    }

    const text = (inputEl.innerText || inputEl.value || "").replace(/\u200B/g, "");
    const trimmed = text.trim();

    if (!trimmed && tokenState.lastDraftText.trim() && !tokenState.isGenerating) {
      if (isGeminiGenerating() || getUserQueryElements().length > tokenState.knownUserCount) {
        startExchangeFromSend(tokenState.lastDraftText);
        return;
      }
    }

    const detail = estimateTokensDetailed(text);
    const attachments = countDraftAttachments();
    tokenState.lastDraftText = text;
    tokenState.draftAttachments = attachments;
    tokenState.draftWords = detail.words;
    tokenState.draftChars = detail.chars;
    tokenState.draftInputTokens = detail.tokens + attachments * 258;

    // Dès qu'on commence à taper un nouveau prompt après un échange terminé, le nouvel échange repart à zéro
    if (
      tokenState.draftInputTokens > 0 &&
      !tokenState.isGenerating &&
      (tokenState.exchangeOutputTokens > 0 || tokenState.exchangeInputTokens > 0)
    ) {
      tokenState.exchangeInputTokens = 0;
      tokenState.exchangeThinkingTokens = 0;
      tokenState.exchangeResponseTokens = 0;
      tokenState.exchangeResponseWords = 0;
      tokenState.exchangeOutputTokens = 0;
      tokenState.thinkingSource = "none";
      tokenState.thinkingSeconds = 0;
    }

    updateTokenWidgetUI();
  }

  function bindPromptInputListeners() {
    const inputEl = getPromptInputElement();
    if (!inputEl || boundTextareaEl === inputEl) return;
    boundTextareaEl = inputEl;

    inputEl.addEventListener("input", handleDraftInputChange);
    inputEl.addEventListener("keyup", handleDraftInputChange);
    inputEl.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          // Ne pas compter comme un envoi si le menu "@" ou un menu autocomplete est ouvert
          if (isAutocompleteOverlayOpen()) return;
          const text = (inputEl.innerText || inputEl.value || "").trim();
          if (text) {
            setTimeout(() => startExchangeFromSend(text), 20);
          }
        }
      },
      true
    );

    // Observer le clic sur le bouton Envoyer (une seule fois)
    if (!sendClickBound) {
      sendClickBound = true;
      document.addEventListener(
        "click",
        (e) => {
          if (!isEnabled) return;
          const target = e.target instanceof Element ? e.target : null;
          const sendBtn = target?.closest(
            'button[aria-label*="Envoyer" i], button[aria-label*="Send" i], button[mattooltip*="Envoyer" i], button[mattooltip*="Send" i], .send-button'
          );
          if (sendBtn) {
            const currentEl = getPromptInputElement();
            const text = (currentEl?.innerText || currentEl?.value || tokenState.lastDraftText || "").trim();
            if (text) {
              setTimeout(() => startExchangeFromSend(text), 20);
            }
          }
        },
        true
      );
    }
  }

  function findModelRowAnchor() {
    const modeEl =
      document.querySelector('[data-test-id="bard-mode-menu-button"]') ||
      document.querySelector("bard-mode-switcher");
    if (!modeEl) return null;

    // Remonter jusqu'au conteneur flex horizontal qui contient le sélecteur de modèle
    let current = modeEl;
    for (let i = 0; i < 4 && current && current.parentElement; i += 1) {
      const parent = current.parentElement;
      const style = window.getComputedStyle(parent);
      if (
        (style.display === "flex" || style.display === "inline-flex") &&
        (style.flexDirection === "row" || style.flexDirection === "row-reverse")
      ) {
        return { container: parent, beforeNode: current };
      }
      current = parent;
    }
    return null;
  }

  function ensureTokenWidgetInjected() {
    if (!isEnabled) return;
    const anchor = findModelRowAnchor();
    if (!anchor) return;

    let widget = document.getElementById(TOKEN_WIDGET_ID);
    if (!widget) {
      widget = document.createElement("button");
      widget.id = TOKEN_WIDGET_ID;
      widget.type = "button";
      widget.className = "ge-token-widget";
      widget.innerHTML = `
        <span class="ge-tok-item ge-tok-in" title="Tokens d'entrée estimés (prompt)">
          <span class="ge-tok-arrow">↑</span>
          <span data-tok="in">0</span>
        </span>
        <span class="ge-tok-sep" aria-hidden="true">·</span>
        <span class="ge-tok-item ge-tok-out" title="Tokens de sortie estimés (réponse + réflexion)">
          <span class="ge-tok-arrow">↓</span>
          <span data-tok="out">0</span>
        </span>
        <span class="ge-tok-sep" aria-hidden="true">·</span>
        <span class="ge-tok-item ge-tok-turn" title="Total de cet échange">
          <span data-tok="turn">0</span>
        </span>
        <span class="ge-tok-sep" aria-hidden="true">|</span>
        <span class="ge-tok-item ge-tok-conv" title="Total cumulé de la conversation">
          <span class="ge-tok-sigma">Σ</span>
          <span data-tok="conv">0</span>
        </span>
      `;

      widget.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleTokenPopover(widget);
      });
      stopBubblePropagation(widget);
    }

    if (widget.parentElement !== anchor.container) {
      anchor.container.insertBefore(widget, anchor.beforeNode);
    }

    if (!tokenState.historyScanned) {
      scanExistingConversationTokens();
    }

    updateTokenWidgetUI();
  }

  function ensureTokenPopoverExists() {
    let pop = document.getElementById(TOKEN_POPOVER_ID);
    if (pop) return pop;

    pop = document.createElement("div");
    pop.id = TOKEN_POPOVER_ID;
    pop.className = "ge-token-popover";
    pop.hidden = true;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Détail des tokens");

    pop.innerHTML = `
      <div class="ge-tpop-header">
        <span class="ge-tpop-title">Estimation des tokens</span>
        <div class="ge-tpop-actions">
          <button type="button" class="ge-tpop-refresh" title="Recalculer / Actualiser les tokens de cette conversation">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
          <button type="button" class="ge-tpop-reset" title="Remettre à zéro le compteur">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
            </svg>
          </button>
        </div>
      </div>
      <div class="ge-tpop-row">
        <span>Prompt en cours (Entrée)</span>
        <strong data-tpop="draft">0 tok</strong>
      </div>
      <div class="ge-tpop-sub" data-tpop="draft-sub">0 mot · 0 car.</div>
      <div class="ge-tpop-divider"></div>
      <div class="ge-tpop-row">
        <span>Entrée envoyée (Échange)</span>
        <strong data-tpop="ex-in">0 tok</strong>
      </div>
      <div class="ge-tpop-row">
        <span>Réflexion (Thinking)</span>
        <strong data-tpop="ex-think">0 tok</strong>
      </div>
      <div class="ge-tpop-row">
        <span>Réponse générée (Sortie)</span>
        <strong data-tpop="ex-resp">0 tok</strong>
      </div>
      <div class="ge-tpop-row ge-tpop-total">
        <span>Total de l'échange</span>
        <strong data-tpop="ex-total">0 tok</strong>
      </div>
      <div class="ge-tpop-divider"></div>
      <div class="ge-tpop-row ge-tpop-conv">
        <span>Total conversation (Σ)</span>
        <strong data-tpop="conv-total">0 tok</strong>
      </div>
      <div class="ge-tpop-sub" data-tpop="conv-sub">0 échange</div>
    `;

    pop.addEventListener("click", (e) => e.stopPropagation());
    pop.querySelector(".ge-tpop-refresh").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      tokenState.historyScanned = false;
      tokenState.knownUserCount = 0;
      tokenState.knownModelCount = 0;
      tokenState.completedTotalTokens = 0;
      tokenState.exchangeInputTokens = 0;
      tokenState.exchangeOutputTokens = 0;
      scanExistingConversationTokens();
      updateTokenWidgetUI();
    });
    pop.querySelector(".ge-tpop-reset").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      tokenState.completedTotalTokens = 0;
      tokenState.exchangeCount = 0;
      tokenState.knownUserCount = getUserQueryElements().length;
      tokenState.knownModelCount = getModelResponseElements().length;
      tokenState.exchangeInputTokens = 0;
      tokenState.exchangeThinkingTokens = 0;
      tokenState.exchangeResponseTokens = 0;
      tokenState.exchangeResponseWords = 0;
      tokenState.exchangeOutputTokens = 0;
      tokenState.thinkingSeconds = 0;
      tokenState.thinkingSource = "none";
      tokenState.historyScanned = true;
      updateTokenWidgetUI();
      persistCurrentTokenState(true);
    });

    document.body.appendChild(pop);
    stopBubblePropagation(pop);
    return pop;
  }

  function toggleTokenPopover(widget) {
    const pop = ensureTokenPopoverExists();
    if (!pop.hidden) {
      pop.hidden = true;
      return;
    }

    pop.hidden = false;
    updateTokenWidgetUI();

    const wRect = widget.getBoundingClientRect();
    const popWidth = 270;
    let left = Math.round(wRect.right - popWidth);
    if (left < 12) left = 12;
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(12, Math.round(wRect.top - 12))}px`;

    requestAnimationFrame(() => {
      const pRect = pop.getBoundingClientRect();
      pop.style.top = `${Math.max(12, Math.round(wRect.top - pRect.height - 10))}px`;
    });
  }

  function updateTokenPopoverContent(displayInput, displayOutput, displayTurn, displayConv) {
    const pop = document.getElementById(TOKEN_POPOVER_ID);
    if (!pop || pop.hidden) return;

    pop.querySelector('[data-tpop="draft"]').textContent = `${displayInput} tok`;
    const attStr = tokenState.draftAttachments > 0 ? ` · ${tokenState.draftAttachments} PJ` : "";
    pop.querySelector('[data-tpop="draft-sub"]').textContent =
      `${tokenState.draftWords} mot(s) · ${tokenState.draftChars} car.${attStr}`;

    pop.querySelector('[data-tpop="ex-in"]').textContent = `${tokenState.exchangeInputTokens} tok`;
    const thinkNote =
      tokenState.thinkingSource === "dom"
        ? " (texte)"
        : tokenState.thinkingSource === "timer"
          ? ` (~${tokenState.thinkingSeconds.toFixed(1)}s)`
          : "";
    pop.querySelector('[data-tpop="ex-think"]').textContent =
      `${tokenState.exchangeThinkingTokens} tok${thinkNote}`;
    pop.querySelector('[data-tpop="ex-resp"]').textContent =
      `${tokenState.exchangeResponseTokens} tok (${tokenState.exchangeResponseWords} mots)`;
    pop.querySelector('[data-tpop="ex-total"]').textContent = `${displayTurn} tok`;
    pop.querySelector('[data-tpop="conv-total"]').textContent = `${displayConv} tok`;
    pop.querySelector('[data-tpop="conv-sub"]').textContent =
      `${tokenState.exchangeCount} échange(s) terminé(s)`;
  }

  function updateTokenWidgetUI() {
    const widget = document.getElementById(TOKEN_WIDGET_ID);
    if (!widget) return;

    const inEl = widget.querySelector('[data-tok="in"]');
    const outEl = widget.querySelector('[data-tok="out"]');
    const turnEl = widget.querySelector('[data-tok="turn"]');
    const convEl = widget.querySelector('[data-tok="conv"]');

    const displayInput = tokenState.draftInputTokens;
    const displayOutput = tokenState.exchangeOutputTokens;
    const exchangeInputForTotal =
      tokenState.draftInputTokens > 0 && !tokenState.isGenerating && tokenState.exchangeOutputTokens === 0
        ? tokenState.draftInputTokens
        : tokenState.exchangeInputTokens + tokenState.draftInputTokens;
    const displayTurn = exchangeInputForTotal + displayOutput;
    const activeUncommitted = tokenState.isGenerating
      ? tokenState.exchangeInputTokens + tokenState.exchangeOutputTokens
      : 0;
    const displayConv =
      tokenState.completedTotalTokens + activeUncommitted + tokenState.draftInputTokens;

    inEl.textContent = formatCompactTokenCount(displayInput);
    outEl.textContent = formatCompactTokenCount(displayOutput);
    turnEl.textContent = formatCompactTokenCount(displayTurn);
    convEl.textContent = formatCompactTokenCount(displayConv);

    widget.classList.toggle("ge-tok-live", tokenState.isGenerating);
    widget.title =
      `Entrée prompt : ${displayInput} tok (${tokenState.draftWords} mots)\n` +
      `Sortie : ${displayOutput} tok (Réflexion ${tokenState.exchangeThinkingTokens} + Réponse ${tokenState.exchangeResponseTokens})\n` +
      `Total échange : ${displayTurn} tok\n` +
      `Total conversation : ${displayConv} tok (${tokenState.exchangeCount} échanges)\n` +
      `Cliquer pour le détail`;

    updateTokenPopoverContent(displayInput, displayOutput, displayTurn, displayConv);
  }

  function handleVisibilityChange() {
    if (isEnabled && !document.hidden) {
      fetchUsageViaIframe();
    }
  }

  function applyState(enabled) {
    isEnabled = enabled;
    if (enabled) {
      document.documentElement.classList.add(ROOT_CLASS);
      try { ensureBubbleExists(); } catch (e) { console.error("[Gemini Extra] init bubble:", e); }
      try { ensureTokenWidgetInjected(); } catch (e) { console.error("[Gemini Extra] init tokens:", e); }
      try { bindPromptInputListeners(); } catch (e) { console.error("[Gemini Extra] init input:", e); }
      try { scanForModelMenu(); } catch (e) { console.error("[Gemini Extra] init menu:", e); }
      startDomObserver();
      startAutoRefresh();
      document.addEventListener("visibilitychange", handleVisibilityChange);
    } else {
      document.documentElement.classList.remove(ROOT_CLASS);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopAutoRefresh();
      stopDomObserver();
      removeUI();
    }
  }

  async function init() {
    try {
      const accountKey = getAccountKey();
      const currentPath = window.location.pathname;
      const {
        enabled = true,
        quotaByAccount = {},
        quotaData,
        tokenStatesByPath = {}
      } = await browser.storage.local.get([
        "enabled",
        "quotaByAccount",
        "quotaData",
        "tokenStatesByPath"
      ]);

      for (const [p, st] of Object.entries(tokenStatesByPath)) {
        if (st && typeof st === "object") {
          conversationStates.set(p, { ...createEmptyTokenState(), ...st, isGenerating: false });
        }
      }
      if (conversationStates.has(currentPath)) {
        tokenState = { ...conversationStates.get(currentPath), historyScanned: false };
      }

      if (quotaByAccount[accountKey]) {
        currentQuota = quotaByAccount[accountKey];
      } else if (quotaData && (!quotaData.accountKey || quotaData.accountKey === accountKey)) {
        currentQuota = quotaData;
      }
      applyState(enabled);
    } catch (err) {
      console.error("[Gemini Extra] Erreur init:", err);
      applyState(true);
    }
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.enabled) {
      applyState(changes.enabled.newValue);
    }
    const accountKey = getAccountKey();
    if (changes.quotaByAccount?.newValue?.[accountKey]) {
      currentQuota = changes.quotaByAccount.newValue[accountKey];
      updateFlyoutContent();
    } else if (changes.quotaData?.newValue && changes.quotaData.newValue.accountKey === accountKey) {
      currentQuota = changes.quotaData.newValue;
      updateFlyoutContent();
    }
  });

  init();
})();
