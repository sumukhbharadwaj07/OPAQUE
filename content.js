/* Opaque — content script.
 *
 * Runs inside the page. Does three things:
 *   1. Tier 0 — reads the page's own structure. A field marked
 *      type="password" needs no model to identify.
 *   2. Tier 1 — scans visible text for values that satisfy a checksum
 *      or a strict format, and records exactly where each one sits.
 *   3. Paints opaque boxes over those positions BEFORE any screenshot is
 *      taken, so an unredacted capture is never produced in the first place.
 */
(function () {
  "use strict";

  var OVERLAY_ID = "__opaque_overlay__";
  var lastFindings = [];

  /* ---------------- overlay ---------------- */

  function overlayRoot(create) {
    var el = document.getElementById(OVERLAY_ID);
    if (!el && create) {
      el = document.createElement("div");
      el.id = OVERLAY_ID;
      el.setAttribute("data-opaque", "1");
      el.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647",
        "pointer-events:none", "margin:0", "padding:0", "border:0"
      ].join(";");
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function clearOverlay() {
    var el = overlayRoot(false);
    if (el) el.remove();
  }

  function paintBox(root, rect, label, severity) {
    if (rect.width < 2 || rect.height < 2) return;
    var pad = 2;
    var d = document.createElement("div");
    d.style.cssText = [
      "position:fixed",
      "left:" + (rect.left - pad) + "px",
      "top:" + (rect.top - pad) + "px",
      "width:" + (rect.width + pad * 2) + "px",
      "height:" + (rect.height + pad * 2) + "px",
      "background:#10161D",
      "border-radius:2px",
      "pointer-events:none"
    ].join(";");
    root.appendChild(d);

    if (label && rect.width > 44) {
      var t = document.createElement("div");
      t.textContent = label;
      t.style.cssText = [
        "position:fixed",
        "left:" + (rect.left - pad) + "px",
        "top:" + (rect.top + rect.height + pad + 1) + "px",
        "font:600 9px ui-monospace,Menlo,Consolas,monospace",
        "color:" + (severity === "high" ? "#F0A030" : "#7FB7AC"),
        "background:rgba(16,22,29,.88)",
        "padding:1px 4px", "border-radius:2px",
        "pointer-events:none", "white-space:nowrap"
      ].join(";");
      root.appendChild(t);
    }
  }

  /* ---------------- visibility ---------------- */

  function isVisible(node) {
    var el = node.nodeType === 3 ? node.parentElement : node;
    if (!el) return false;
    if (el.closest("[data-opaque]")) return false;
    var tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) {
      return false;
    }
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    /* only what is actually on screen — that is what a screenshot would show */
    return r.bottom > 0 && r.top < window.innerHeight &&
           r.right > 0 && r.left < window.innerWidth;
  }

  /* ---------------- Tier 0: the page describes itself ---------------- */

  function labelFor(input) {
    if (input.getAttribute("aria-label")) return input.getAttribute("aria-label");
    if (input.id) {
      var l = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
      if (l && l.textContent.trim()) return l.textContent.trim();
    }
    var wrap = input.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim().slice(0, 60);
    if (input.placeholder) return input.placeholder;
    if (input.name) return input.name;
    return input.type || "field";
  }

  var SENSITIVE_AUTOCOMPLETE = /^(cc-|new-password|current-password|one-time-code)/;

  function scanInputs() {
    var out = [];
    var inputs = document.querySelectorAll("input, textarea, select");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (!isVisible(el)) continue;

      var label = labelFor(el);
      var type = (el.type || "").toLowerCase();
      var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
      var rect = el.getBoundingClientRect();

      /* Password values are never read. Their existence is enough. */
      if (type === "password" || SENSITIVE_AUTOCOMPLETE.test(ac)) {
        out.push({
          tier: 0, kind: type === "password" ? "Password field" : "Sensitive field",
          ph: type === "password" ? "[PASSWORD]" : "[SENSITIVE]",
          ev: type === "password" ? 'DOM: input[type="password"]'
                                  : 'DOM: autocomplete="' + ac + '"',
          severity: "high", label: label, match: "(never read)",
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        });
        continue;
      }

      /* Tier 1 applied to what the user has typed into ordinary fields. */
      var val = (el.value || "").trim();
      if (!val) {
        out.push({ tier: null, label: label, value: "", rect: null });
        continue;
      }
      var hits = OpaqueDetect.scan(val);
      if (hits.length) {
        out.push({
          tier: 1, kind: hits[0].kind, ph: hits[0].ph, ev: hits[0].ev,
          severity: hits[0].severity, label: label, match: hits[0].match,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        });
      } else {
        out.push({ tier: null, label: label, value: val.slice(0, 80), rect: null });
      }
    }
    return out;
  }

  /* ---------------- Tier 1: text nodes ---------------- */

  function scanTextNodes() {
    var out = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return isVisible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    var node;
    while ((node = walker.nextNode())) {
      var text = node.nodeValue;
      var hits = OpaqueDetect.scan(text);
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        var range = document.createRange();
        try {
          range.setStart(node, h.start);
          range.setEnd(node, h.end);
        } catch (e) { continue; }
        var rects = range.getClientRects();
        for (var r = 0; r < rects.length; r++) {
          var rc = rects[r];
          if (rc.width < 2 || rc.height < 2) continue;
          out.push({
            tier: 1, kind: h.kind, ph: h.ph, ev: h.ev, severity: h.severity,
            match: h.match, label: null,
            rect: { left: rc.left, top: rc.top, width: rc.width, height: rc.height }
          });
        }
      }
    }
    return out;
  }

  /* ---------------- sanitised summary for the model ---------------- */

  function visibleTextOutline(limit) {
    var parts = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return isVisible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var node, total = 0;
    while ((node = walker.nextNode())) {
      var t = node.nodeValue.replace(/\s+/g, " ").trim();
      if (t.length < 2) continue;
      var safe = OpaqueDetect.redactText(t);
      parts.push(safe);
      total += safe.length;
      if (total > limit) break;
    }
    return parts.join(" | ");
  }

  function buildContext() {
    var inputs = scanInputs();

    var headings = [];
    document.querySelectorAll("h1,h2,h3").forEach(function (h) {
      if (isVisible(h) && h.textContent.trim()) {
        headings.push(OpaqueDetect.redactText(h.textContent.replace(/\s+/g, " ").trim()));
      }
    });

    var actions = [];
    document.querySelectorAll(
      'button, a[href], input[type="submit"], input[type="button"], [role="button"]'
    ).forEach(function (b) {
      if (!isVisible(b)) return;
      var t = (b.innerText || b.value || b.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim();
      if (t && t.length < 60 && actions.indexOf(t) === -1) actions.push(t);
    });

    var fields = inputs.map(function (f) {
      if (f.tier === 0 || f.tier === 1) {
        return { label: f.label, value: f.ph, masked: true };
      }
      return { label: f.label, value: f.value || "(empty)", masked: false };
    });

    return {
      url: location.origin + location.pathname,
      title: document.title,
      headings: headings.slice(0, 12),
      fields: fields.slice(0, 40),
      actions: actions.slice(0, 25),
      text: visibleTextOutline(1800),
      viewport: { w: window.innerWidth, h: window.innerHeight,
                  dpr: window.devicePixelRatio || 1 }
    };
  }

  /* ---------------- orchestration ---------------- */

  function runScan(paint) {
    clearOverlay();

    var findings = scanTextNodes().concat(
      scanInputs().filter(function (f) { return f.tier === 0 || f.tier === 1; })
    );

    /* drop duplicates covering the same spot */
    var seen = [];
    findings = findings.filter(function (f) {
      if (!f.rect) return true;
      for (var i = 0; i < seen.length; i++) {
        var s = seen[i];
        if (Math.abs(s.left - f.rect.left) < 6 && Math.abs(s.top - f.rect.top) < 6) {
          return false;
        }
      }
      seen.push(f.rect);
      return true;
    });

    lastFindings = findings;

    if (paint) {
      var root = overlayRoot(true);
      findings.forEach(function (f) {
        if (f.rect) paintBox(root, f.rect, f.ph, f.severity);
      });
    }

    return {
      findings: findings.map(function (f) {
        return { tier: f.tier, kind: f.kind, ph: f.ph, ev: f.ev,
                 severity: f.severity, label: f.label, match: f.match };
      }),
      context: buildContext()
    };
  }

  /* Reposition boxes if the page moves under them. */
  var repaintTimer = null;
  function schedulePaint() {
    if (!document.getElementById(OVERLAY_ID)) return;
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(function () { runScan(true); }, 120);
  }
  window.addEventListener("scroll", schedulePaint, { passive: true });
  window.addEventListener("resize", schedulePaint, { passive: true });

  /* ---------------- messaging ---------------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    try {
      if (msg.type === "OPAQUE_SCAN") {
        reply({ ok: true, data: runScan(msg.paint !== false) });
      } else if (msg.type === "OPAQUE_CLEAR") {
        clearOverlay();
        reply({ ok: true });
      } else if (msg.type === "OPAQUE_PING") {
        reply({ ok: true });
      } else if (msg.type === "OPAQUE_ACT") {
        reply({ ok: true, result: performAction(msg.action, msg.target) });
      }
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) });
    }
    return true;
  });

  /* ---------------- acting on the page ----------------
   * Deliberately limited. Scrolling and highlighting only. Clicking is not
   * performed automatically: a model should not be able to submit a form on
   * someone's behalf without a person deciding to.
   */
  function performAction(action, target) {
    if (action === "scroll") {
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      return "scrolled";
    }
    if (action === "highlight" && target) {
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('button, a[href], input, [role="button"]')
      );
      var needle = String(target).toLowerCase();
      var hit = candidates.find(function (el) {
        var t = (el.innerText || el.value || el.getAttribute("aria-label") || "")
          .toLowerCase();
        return t && t.indexOf(needle) !== -1;
      });
      if (!hit) return "no element matching " + target;
      hit.scrollIntoView({ block: "center", behavior: "smooth" });
      var prev = hit.style.outline;
      hit.style.outline = "3px solid #F0A030";
      setTimeout(function () { hit.style.outline = prev; }, 2400);
      return "highlighted " + target;
    }
    return "unsupported action";
  }
})();
