const DEFAULT_SETTINGS = {
  enabled: true
};

const DNR_RULE_IDS = [1001, 1002];

async function setupUsageFrameRules() {
  if (!browser.declarativeNetRequest?.updateDynamicRules) return;
  try {
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: DNR_RULE_IDS,
      addRules: [
        {
          id: 1001,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "x-frame-options", operation: "remove" },
              { header: "content-security-policy", operation: "remove" }
            ]
          },
          condition: {
            urlFilter: "||gemini.google.com/usage",
            resourceTypes: ["sub_frame"]
          }
        },
        {
          id: 1002,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "x-frame-options", operation: "remove" },
              { header: "content-security-policy", operation: "remove" }
            ]
          },
          condition: {
            urlFilter: "||gemini.google.com/u/*/usage",
            resourceTypes: ["sub_frame"]
          }
        }
      ]
    });
  } catch (err) {
    console.warn("[Gemini Extra] DNR setup warning:", err);
  }
}

browser.runtime.onInstalled.addListener(async () => {
  const existing = await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const toSet = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) {
      toSet[key] = value;
    }
  }

  if (Object.keys(toSet).length > 0) {
    await browser.storage.local.set(toSet);
  }

  await setupUsageFrameRules();
  console.info("[Gemini Extra] Extension initialisée.");
});

setupUsageFrameRules();

browser.runtime.onMessage.addListener((message) => {
  if (message?.action === "openUsagePage") {
    const targetUrl =
      typeof message.url === "string" && message.url.startsWith("https://gemini.google.com/")
        ? message.url
        : "https://gemini.google.com/usage";
    return browser.tabs.create({ url: targetUrl });
  }
  return undefined;
});

// Fallback webRequest pour autoriser le sub_frame /usage (multi-comptes /u/X/usage inclus)
if (browser.webRequest?.onHeadersReceived) {
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const responseHeaders = (details.responseHeaders || [])
        .filter((header) => header.name.toLowerCase() !== "x-frame-options")
        .map((header) => {
          if (header.name.toLowerCase() === "content-security-policy" && header.value) {
            const cleaned = header.value
              .split(";")
              .filter((directive) => !directive.trim().toLowerCase().startsWith("frame-ancestors"))
              .join(";");
            return { ...header, value: cleaned };
          }
          return header;
        });

      return { responseHeaders };
    },
    {
      urls: [
        "https://gemini.google.com/usage*",
        "https://gemini.google.com/u/*/usage*"
      ],
      types: ["sub_frame"]
    },
    ["blocking", "responseHeaders"]
  );
}
