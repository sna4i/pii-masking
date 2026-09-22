// Content script — isolated-world bridge.
//
// MV3 content scripts run in an isolated JS world by default, which
// means monkey-patching ``window.fetch`` here only patches the
// extension's own wrapper, not the page's real fetch. We therefore:
//
// 1. Inject ``injected.js`` into the page's MAIN world via a script
//    tag. That script patches the real ``window.fetch`` and
//    ``XMLHttpRequest.prototype.send``.
// 2. Provide a ``window.postMessage`` bridge so the injected script
//    (which has no ``chrome.*`` access) can:
//      a) ask the isolated world to POST to the gateway on its behalf,
//         and
//      b) read the ``enabled`` flag from ``chrome.storage.local``.
//    The isolated world then relays detection counts back to the
//    service worker.
//
// All injected-script → content-script messages are tagged with
// ``source: "mask-mcp-inpage"`` so the page's own ``message`` handlers
// don't see them (and vice-versa for ``mask-mcp-content``).

(() => {
  "use strict";

  const TAG_IN = "mask-mcp-inpage";   // injected → content
  const TAG_OUT = "mask-mcp-content"; // content → injected

  const GATEWAY_URL = "http://127.0.0.1:8081/v1/extension/sanitize";
  const GATEWAY_AGGREGATED_URL =
    "http://127.0.0.1:8081/v1/extension/sanitize/aggregated";
  const GATEWAY_HEALTH_URL = "http://127.0.0.1:8081/health";
  // Bumped from 3000 -> 15000 because the FIRST call from Chrome on
  // Windows to a WSL2-hosted gateway routinely takes several seconds:
  // Chrome's CORS-RFC1918 preflight on public-to-private fetches gets
  // re-negotiated on every fresh tab, and Windows's ephemeral port
  // mapping into the WSL2 VM has cold-start overhead that does NOT
  // show up when curling from inside WSL. Once warm the call is
  // milliseconds, but the first click in a fresh tab needs head-room.
  const GATEWAY_TIMEOUT_MS = 15000;

  // Cached gateway reachability. Hybrid dispatch in injected.js
  // consults this (via a postMessage round-trip) to decide whether to
  // call the gateway or fall back to the standalone engine. The
  // pre-warm below flips ``gatewayReachable`` true on a successful
  // /health response; injected.js can also ask for a refresh.
  let gatewayReachable = null; // null = unknown yet, true/false once probed
  const GATEWAY_PROBE_TIMEOUT_MS = 500;

  async function probeGateway() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        GATEWAY_PROBE_TIMEOUT_MS
      );
      try {
        const resp = await fetch(GATEWAY_HEALTH_URL, {
          method: "GET",
          mode: "cors",
          credentials: "omit",
          signal: controller.signal,
        });
        gatewayReachable = resp.ok;
        return resp.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (_) {
      gatewayReachable = false;
      return false;
    }
  }

  // Pre-warm: hit /health in the background on content script load.
  // Also completes the PNA preflight + TCP warmup for the common
  // gateway-mode path. Sets gatewayReachable for Hybrid dispatch.
  (async () => {
    const t0 = Date.now();
    const ok = await probeGateway();
    const elapsed = Date.now() - t0;
    if (ok) {
      console.debug("[pii-guard] gateway warmup ok in", elapsed + "ms");
    } else {
      console.debug(
        "[pii-guard] gateway unreachable at warmup — standalone engine will handle masking"
      );
    }
  })();

  // 1) Inject the page-world scripts in order:
  //    ``review-modal.js`` and ``sidebar.js`` must run before
  //    ``injected.js`` so the helper namespaces are already attached
  //    to ``window.__localMaskMCP.{reviewModal,sidebar}`` by the time
  //    the fetch hook tries to call them. ``document_start`` runs
  //    before any page script, so all three hooks are installed before
  //    the first fetch leaves the page. The ``async = false`` flag
  //    preserves source order despite the dynamic insertion.
  function injectScript(file) {
    const el = document.createElement("script");
    el.src = chrome.runtime.getURL(file);
    el.async = false;
    (document.head || document.documentElement).appendChild(el);
    el.addEventListener("load", () => el.remove());
  }
  // Engine modules are loaded BEFORE review-modal / sidebar / injected.js
  // so window.__localMaskMCP.engine is ready by the time injected.js's
  // first fetch intercept fires. Order matters: the leaf modules (no
  // cross-engine deps) must load before engine.js and the final
  // bundle.js launcher that flips engine.ready = true.
  // Each file is a MV3-safe script (no ES6 import / eval).
  //
  // v1.2.0: LLM engine files (surrogates.js, llm-prompts.js) now ship
  // to the Chrome Web Store build as well. Any LAN/localhost fetch they
  // eventually drive is gated by `optional_host_permissions: ["http://*/*"]`
  // in manifest.store.json — the user must approve that host at runtime
  // from the options page before the LLM proxy paths can succeed.
  const ENGINE_FILES = [
    // dictionaries.js must load BEFORE patterns.js — patterns.js references
    // dicts.JP_SURNAME_RE etc. at BUILTIN_PATTERNS construction time.
    "engine/dictionaries.js",
    "engine/patterns.js",
    "engine/classification.js",
    "engine/severity.js",
    "engine/categories.js",
    "engine/aggregate.js",
    "engine/force-mask.js",
    "engine/blocklist.js",
    "engine/user-force-mask.js",
    "engine/onnx-detector.js",
    "engine/confidential.js",
    "engine/surrogates.js",
    "engine/llm-prompts.js",
    "engine/engine.js",
    "engine/bundle.js",
  ];
  for (const f of ENGINE_FILES) injectScript(f);
  injectScript("review-modal.js");
  injectScript("sidebar.js");
  injectScript("injected.js");
  console.debug(
    "[pii-guard] injected",
    ENGINE_FILES.length + 3,
    "scripts (engine + ui + hook)"
  );

  // Push the current ``interactive`` + ``uiMode`` preferences into
  // MAIN world as soon as we can. The injected script reads them off
  // ``window.__localMaskMCP.settings`` before every fetch, so a
  // toggle in the popup takes effect on the very next intercept.
  // ``uiMode`` defaults to ``"sidebar"`` (Milestone 8 Wave B); the
  // legacy modal experience is opt-in via the popup radio.
  async function broadcastSettings() {
    let interactive = true;
    let uiMode = "sidebar";
    let maskAllowlist = [];
    let maskForceList = [];
    let mlEnabled = false;
    try {
      const stored = await chrome.storage.local.get([
        "interactive", "uiMode", "maskAllowlist", "maskForceList", "mlEnabled",
      ]);
      if (typeof stored.mlEnabled === "boolean") mlEnabled = stored.mlEnabled;
      interactive = stored.interactive !== false;
      if (stored.uiMode === "modal" || stored.uiMode === "sidebar") {
        uiMode = stored.uiMode;
      }
      if (Array.isArray(stored.maskAllowlist)) {
        maskAllowlist = stored.maskAllowlist.filter((v) => typeof v === "string");
      }
      if (Array.isArray(stored.maskForceList)) {
        // サイドバー drop で追加された user force-mask list。
        // 各 entry は { value: string, category: string } の最小形式。
        // 互換: 古い文字列配列はカテゴリなし (OTHER) で読み込む。
        maskForceList = stored.maskForceList
          .map((e) => typeof e === "string"
            ? { value: e, category: "OTHER" }
            : (e && typeof e.value === "string")
              ? { value: e.value, category: typeof e.category === "string" ? e.category : "OTHER" }
              : null)
          .filter(Boolean);
      }
    } catch (_) {
      interactive = true;
      uiMode = "sidebar";
    }
    window.postMessage(
      {
        source: TAG_OUT,
        type: "settings",
        settings: { interactive, uiMode, maskAllowlist, maskForceList, mlEnabled },
      },
      "*"
    );
  }
  broadcastSettings();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if ("interactive" in changes || "uiMode" in changes || "maskAllowlist" in changes || "maskForceList" in changes || "mlEnabled" in changes) {
        broadcastSettings();
      }
    });
  } catch (_) {
    // ``chrome.storage`` is always available in an MV3 content
    // script; the guard exists only to avoid bricking the page if
    // the API ever throws at boot.
  }

  // 2) Handle page-world requests.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG_IN) return;

    // Allowlist add (no id — fire-and-forget write to chrome.storage).
    if (data.type === "add-allowlist" && typeof data.value === "string") {
      (async () => {
        try {
          const { maskAllowlist = [] } = await chrome.storage.local.get("maskAllowlist");
          const v = data.value.trim();
          if (v && !maskAllowlist.includes(v)) {
            maskAllowlist.push(v);
            await chrome.storage.local.set({ maskAllowlist });
          }
        } catch (_) {}
      })();
      return;
    }

    // Force-mask list add — drop-and-pick-category flow from the sidebar.
    if (data.type === "add-forcelist" && typeof data.value === "string") {
      (async () => {
        try {
          const { maskForceList = [] } = await chrome.storage.local.get("maskForceList");
          const normalized = maskForceList.map((e) =>
            typeof e === "string"
              ? { value: e, category: "OTHER" }
              : { value: e.value, category: e.category || "OTHER" }
          );
          const v = data.value;
          const cat = typeof data.category === "string" ? data.category : "OTHER";
          if (v && !normalized.some((e) => e.value === v && e.category === cat)) {
            normalized.push({ value: v, category: cat });
            await chrome.storage.local.set({ maskForceList: normalized });
          }
        } catch (e) {
          console.warn("[pii-guard] force-mask add failed:", e && e.message ? e.message : e);
        }
      })();
      return;
    }

    // Force-mask list remove — ( value + category ) ペアで一致を削除。
    if (data.type === "remove-forcelist" && typeof data.value === "string") {
      (async () => {
        try {
          const { maskForceList = [] } = await chrome.storage.local.get("maskForceList");
          const v = data.value;
          const cat = typeof data.category === "string" ? data.category : null;
          const next = maskForceList.filter((e) => {
            const ev = typeof e === "string" ? e : e.value;
            const ec = typeof e === "string" ? "OTHER" : (e.category || "OTHER");
            return !(ev === v && (cat === null || ec === cat));
          });
          await chrome.storage.local.set({ maskForceList: next });
        } catch (_) {}
      })();
      return;
    }

    if (typeof data.id !== "string") return;

    if (data.type === "sanitize") {
      handleSanitize(data);
    } else if (data.type === "sanitize-aggregated") {
      handleSanitizeAggregated(data);
    } else if (data.type === "is-enabled") {
      handleIsEnabled(data);
    } else if (data.type === "backend-probe") {
      handleBackendProbe(data);
    } else if (data.type === "hybrid-pref") {
      handleHybridPref(data);
    }
    else if (data.type === "llm-config") {
      handleLlmConfig(data);
    } else if (data.type === "llm-call") {
      handleLlmCall(data);
    } else if (data.type === "detection-count") {
      // Fire-and-forget badge update.
      try {
        chrome.runtime.sendMessage({
          type: "DETECTION_COUNT",
          count: Number(data.count) || 0,
        });
      } catch (_) {
        // Service worker might be asleep; not fatal.
      }
    }
  });

  async function handleSanitize(data) {
    const { id, payload } = data;
    const responseBody = await callGateway(GATEWAY_URL, payload);
    window.postMessage(
      { source: TAG_OUT, id, type: "sanitize-result", result: responseBody },
      "*"
    );
  }

  async function handleSanitizeAggregated(data) {
    const { id, payload } = data;
    const responseBody = await callGateway(GATEWAY_AGGREGATED_URL, payload);
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "sanitize-aggregated-result",
        result: responseBody,
      },
      "*"
    );
  }

  // Shared transport for the two sanitize endpoints. Identical
  // request semantics; only the URL changes. Returns null on any
  // failure so the caller can fall back to ``confirmSendUnmasked``.
  async function callGateway(url, payload) {
    let responseBody = null;
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
          mode: "cors",
          credentials: "omit",
        });
        if (resp.ok) {
          responseBody = await resp.json();
          const elapsed = Date.now() - t0;
          if (elapsed > 1500) {
            console.info(
              "[pii-guard] gateway slow:",
              elapsed + "ms",
              "url:",
              url
            );
          }
        } else {
          console.warn("[pii-guard] gateway returned", resp.status, "for", url);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const elapsed = Date.now() - t0;
      if (err && err.name === "AbortError") {
        console.warn(
          "[pii-guard] gateway timed out after",
          elapsed + "ms (limit",
          GATEWAY_TIMEOUT_MS + "ms)."
        );
      } else {
        console.warn(
          "[pii-guard] gateway call failed after",
          elapsed + "ms:",
          err?.message || err,
          "url:",
          url
        );
      }
    }
    return responseBody;
  }

  // Hybrid mode: report current gateway reachability to the injected
  // script. Refresh on demand if ``data.refresh === true``, otherwise
  // return the cached value (populated by the warmup probe or the last
  // refresh call). Result is also used to display a badge update when
  // we fall back to standalone mode.
  async function handleBackendProbe(data) {
    const { id } = data;
    if (data.refresh === true || gatewayReachable === null) {
      await probeGateway();
    }
    const reachable = gatewayReachable === true;
    try {
      chrome.runtime.sendMessage({
        type: "BACKEND_MODE",
        mode: reachable ? "gateway" : "standalone",
      });
    } catch (_) {
      // service worker asleep — not fatal.
    }
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "backend-probe-result",
        reachable,
      },
      "*"
    );
  }

  // Returns the user's Hybrid-mode preference from chrome.storage.local.
  // Recognised values:
  //   "auto"       — probe gateway, fall back to standalone (default)
  //   "standalone" — never call gateway, always use local engine
  //   "gateway"    — always use gateway (legacy behaviour); fail loudly
  //                  if unreachable. Expert-mode only.
  async function handleHybridPref(data) {
    const { id } = data;
    // Web Store build: default to standalone (no Docker required).
    // Power users can opt into "gateway" / "auto" via DevTools but
    // the shipped UX assumes a self-contained browser-only engine.
    let pref = "standalone";
    try {
      const stored = await chrome.storage.local.get(["mask_mcp_pref_hybrid"]);
      const v = stored.mask_mcp_pref_hybrid;
      if (v === "standalone" || v === "gateway" || v === "auto") {
        pref = v;
      }
    } catch (_) {
      pref = "standalone";
    }
    window.postMessage(
      {
        source: TAG_OUT,
        id,
        type: "hybrid-pref-result",
        pref,
      },
      "*"
    );
  }

  // v0.5.0 — Local LLM proxy. The page world never directly calls
  // the user-configured LLM URL; it asks us via postMessage and we
  // execute the fetch from the isolated content script (which, after
  // the user grants `http://*/*` via permissions.request() from the
  // options page, holds the runtime host permission).
  //
  // v1.2.0: the handlers below ship to the Chrome Web Store build too.
  // They are no-ops until the user (a) sets localLlmEnabled + URL from
  // the options page, and (b) approves the `http://*/*` optional host
  // permission prompt. Without those, handleLlmConfig returns
  // `config: null` and handleLlmCall short-circuits.
  async function handleLlmConfig(data) {
    const { id } = data;
    let cfg = null;
    try {
      const stored = await chrome.storage.local.get([
        "localLlmEnabled",
        "localLlmUrl",
        "localLlmModel",
        "localLlmMode",
        "localLlmKind",
        "localLlmTimeoutMs",
      ]);
      if (
        stored.localLlmEnabled === true &&
        typeof stored.localLlmUrl === "string" &&
        stored.localLlmUrl
      ) {
        cfg = {
          url: stored.localLlmUrl.replace(/\/+$/, ""),
          model: stored.localLlmModel || "",
          mode: stored.localLlmMode === "replace" ? "replace" : "detect",
          kind: stored.localLlmKind === "openai-compat" ? "openai-compat" : "ollama",
          timeoutMs: Number(stored.localLlmTimeoutMs) || 120000,
        };
      }
    } catch (_) {}
    window.postMessage(
      { source: TAG_OUT, id, type: "llm-config-result", config: cfg },
      "*"
    );
  }

  async function handleLlmCall(data) {
    const { id, system, user, config } = data;
    let result = null;
    if (!config || !config.url) {
      window.postMessage({ source: TAG_OUT, id, type: "llm-call-result", result: null }, "*");
      return;
    }
    // Route the actual fetch through the service worker (background.js)
    // so Chrome's Private Network Access blocker doesn't reject an
    // HTTPS-page content script calling http://localhost.
    const isOpenAi = config.kind === "openai-compat";
    const url = config.url + (isOpenAi ? "/v1/chat/completions" : "/api/chat");
    // Ollama request needs THREE things for thinking-capable models
    // (Qwen3 family, Deepseek-R1, etc.) to emit visible tokens:
    //   1. think: false        — disables the built-in reasoning trace.
    //      Without this, the model burns the entire num_predict budget
    //      on internal <think>…</think> tokens that Ollama hides from
    //      the .message.content field, leaving content = "" at the end.
    //   2. format: "json"      — grammar-constrains the output to valid
    //      JSON so we don't need to strip markdown fences.
    //   3. num_predict: 2048   — enough for a 30-entity detect response
    //      without blowing the context window.
    const body = JSON.stringify(
      isOpenAi
        ? {
            model: config.model || "default",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: false,
            temperature: 0,
            response_format: { type: "json_object" },
            max_tokens: 2048,
          }
        : {
            model: config.model || "qwen3:1.7b",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: false,
            think: false,
            format: "json",
            options: {
              temperature: 0,
              num_predict: 2048,
            },
          }
    );
    // Retry loop for Ollama cold-start. A 9B/8B model can take 30–60s
    // to load into VRAM on first invocation and Ollama returns
    //   500 {"error":"unexpected server status: llm server loading model"}
    // (or a 503) during that window. The body comes back fast, so we
    // can retry cheaply without waiting for the full timeout. We only
    // retry on "loading model" responses — 403 CORS and hard errors
    // bail immediately.
    // Retry budget — split by cause. Cold-start 500/503 "loading
    // model" answers come back fast, so we can poll cheaply. Timeouts
    // (AbortError) are genuine inference stalls — we allow a small
    // number of re-runs so 9B thinking models that exceed one timeout
    // window still get a second chance after the KV cache is warm.
    const WARMUP_MAX = 6;      // 500/503 loading-model retries
    const WARMUP_DELAY_MS = 3000;
    const TIMEOUT_MAX = 2;     // AbortError retries (inference too slow)
    const TIMEOUT_DELAY_MS = 2000;
    let warmupTries = 0;
    let timeoutTries = 0;
    const callStart = Date.now();
    console.debug(
      "[pii-guard] llm fetch start:",
      url,
      "timeout=" + (config.timeoutMs || 120000) + "ms",
    );
    while (true) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "LLM_FETCH",
          url,
          method: "POST",
          body,
          timeoutMs: config.timeoutMs || 120000,
        });
        if (resp && resp.ok && resp.body) {
          const j = JSON.parse(resp.body);
          result = isOpenAi
            ? j?.choices?.[0]?.message?.content
            : j?.message?.content;
          result = result || null;
          console.debug(
            `[pii-guard] llm fetch OK in ${Date.now() - callStart}ms, content=${
              result ? result.length + " chars" : "EMPTY"
            }${result ? "" : " (check num_predict / think settings)"}`,
          );
          break;
        }
        const warming =
          resp &&
          (resp.status === 500 || resp.status === 503) &&
          typeof resp.body === "string" &&
          /loading model|model is still loading|server loading/i.test(resp.body);
        if (warming && warmupTries < WARMUP_MAX) {
          warmupTries++;
          console.debug(
            `[pii-guard] llm warming up (${warmupTries}/${WARMUP_MAX}), waiting ${WARMUP_DELAY_MS}ms…`
          );
          await new Promise((r) => setTimeout(r, WARMUP_DELAY_MS));
          continue;
        }
        // SW-side fetch abort surfaces as { ok:false, error:"signal is
        // aborted without reason" } (or similar). Treat this the same
        // as a JS-side AbortError — allow a couple of re-runs.
        const abortLike =
          resp && !resp.ok && typeof resp.error === "string" &&
          /abort|aborted|AbortError/i.test(resp.error);
        if (abortLike && timeoutTries < TIMEOUT_MAX) {
          timeoutTries++;
          console.debug(
            `[pii-guard] llm inference timeout (${timeoutTries}/${TIMEOUT_MAX}), retrying…`
          );
          await new Promise((r) => setTimeout(r, TIMEOUT_DELAY_MS));
          continue;
        }
        if (resp && resp.status === 403) {
          console.warn(
            "[pii-guard] Ollama returned 403 (CORS). Set OLLAMA_ORIGINS=" +
              "chrome-extension://* or restart ollama with " +
              "OLLAMA_ORIGINS=* env. Docker: `docker run -e OLLAMA_ORIGINS=* ...` " +
              "or `docker exec ollama sh -c 'export OLLAMA_ORIGINS=*'` then restart."
          );
        } else {
          console.debug(
            "[pii-guard] llm call non-ok:",
            resp && (resp.status || resp.error),
            resp && resp.body && resp.body.slice(0, 200)
          );
        }
        break;
      } catch (err) {
        const isAbort = err && err.name === "AbortError";
        if (isAbort && timeoutTries < TIMEOUT_MAX) {
          timeoutTries++;
          console.debug(
            `[pii-guard] llm inference timeout (${timeoutTries}/${TIMEOUT_MAX}), retrying…`
          );
          await new Promise((r) => setTimeout(r, TIMEOUT_DELAY_MS));
          continue;
        }
        console.debug("[pii-guard] llm call failed:", err?.message || err);
        break;
      }
    }
    window.postMessage({ source: TAG_OUT, id, type: "llm-call-result", result }, "*");
  }

  async function handleIsEnabled(data) {
    const { id } = data;
    let enabled = true;
    try {
      const stored = await chrome.storage.local.get("enabled");
      enabled = stored.enabled !== false;
    } catch (_) {
      enabled = true;
    }
    window.postMessage(
      { source: TAG_OUT, id, type: "is-enabled-result", enabled },
      "*"
    );
  }
})();
