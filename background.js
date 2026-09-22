/* Opaque — service worker.
 *
 * Thin by design. Manifest V3 service workers are stopped and restarted
 * unpredictably, so no model and no state lives here. It routes messages and
 * takes the screenshot, nothing more.
 */

chrome.runtime.onInstalled.addListener(function () {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(function (e) { console.warn("sidePanel behaviour:", e); });
  }
});

chrome.action.onClicked.addListener(function (tab) {
  if (chrome.sidePanel && tab && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId })
      .catch(function (e) { console.warn("sidePanel open:", e); });
  }
});

function activeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true })
    .then(function (tabs) {
      var t = tabs && tabs[0];
      if (!t) throw new Error("no active tab");
      if (/^(chrome|edge|about|chrome-extension|devtools):/.test(t.url || "")) {
        throw new Error("Opaque cannot run on browser-internal pages. Open a normal website.");
      }
      return t;
    });
}

/* The content script may be missing on pages that were already open when the
   extension was installed, so inject it on demand. */
function ensureContentScript(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "OPAQUE_PING" })
    .then(function () { return true; })
    .catch(function () {
      return chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["lib/detect.js", "content.js"]
      }).then(function () { return true; });
    });
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {

  if (msg.type === "OPAQUE_RUN") {
    activeTab()
      .then(function (tab) {
        return ensureContentScript(tab.id).then(function () {
          return chrome.tabs.sendMessage(tab.id, {
            type: "OPAQUE_SCAN", paint: msg.paint !== false
          }).then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || "scan failed");
            /* Capture happens only after the boxes are painted, so an
               unredacted screenshot of the page is never created. */
            return new Promise(function (resolve) { setTimeout(resolve, 130); })
              .then(function () {
                return chrome.tabs.captureVisibleTab(tab.windowId, {
                  format: "png"
                });
              })
              .then(function (dataUrl) {
                reply({ ok: true, data: res.data, shot: dataUrl,
                        tabId: tab.id, url: tab.url, title: tab.title });
              })
              .catch(function () {
                /* Capture can fail on protected pages; the text path still works. */
                reply({ ok: true, data: res.data, shot: null,
                        tabId: tab.id, url: tab.url, title: tab.title });
              });
          });
        });
      })
      .catch(function (err) { reply({ ok: false, error: String(err.message || err) }); });
    return true;
  }

  if (msg.type === "OPAQUE_CLEARBOXES") {
    activeTab()
      .then(function (tab) { return chrome.tabs.sendMessage(tab.id, { type: "OPAQUE_CLEAR" }); })
      .then(function () { reply({ ok: true }); })
      .catch(function (err) { reply({ ok: false, error: String(err.message || err) }); });
    return true;
  }

  if (msg.type === "OPAQUE_DOACT") {
    activeTab()
      .then(function (tab) {
        return chrome.tabs.sendMessage(tab.id, {
          type: "OPAQUE_ACT", action: msg.action, target: msg.target
        });
      })
      .then(function (res) { reply(res || { ok: false }); })
      .catch(function (err) { reply({ ok: false, error: String(err.message || err) }); });
    return true;
  }

  return false;
});
