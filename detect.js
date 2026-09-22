/* Opaque — shared detection rules.
 *
 * Loaded as a classic script in both the content script and the side panel,
 * so it defines a single global rather than using module syntax.
 *
 * Tier 1 is deterministic: checksums and formats. No model, no guessing.
 * A twelve digit number that satisfies the Verhoeff check is an Aadhaar number
 * with near certainty, and that costs microseconds instead of an inference pass.
 */
var OpaqueDetect = (function () {
  "use strict";

  /* ---------- Verhoeff, used by Aadhaar ---------- */
  var D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
  ];
  var P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
  ];

  function verhoeff(s) {
    var d = s.replace(/\D/g, "");
    if (d.length !== 12) return false;
    var c = 0;
    for (var i = d.length - 1, n = 0; i >= 0; i--, n++) {
      c = D[c][P[n % 8][+d[i]]];
    }
    return c === 0;
  }

  /* ---------- Luhn, used by payment cards ---------- */
  function luhn(s) {
    var d = s.replace(/\D/g, "");
    if (d.length < 13 || d.length > 19) return false;
    var sum = 0, alt = false;
    for (var i = d.length - 1; i >= 0; i--) {
      var v = +d[i];
      if (alt) { v *= 2; if (v > 9) v -= 9; }
      sum += v; alt = !alt;
    }
    return sum % 10 === 0;
  }

  /* ---------- rule table ----------
   * Ordered most-specific first, because a card number would otherwise be
   * partially swallowed by the looser numeric patterns.
   */
  var RULES = [
    { kind: "Payment card", ph: "[CARD]", tier: 1, severity: "high",
      ev: "Luhn checksum passes",
      re: /\b(?:\d[ -]?){13,19}\b/g, verify: luhn },

    { kind: "Aadhaar number", ph: "[AADHAAR]", tier: 1, severity: "high",
      ev: "Verhoeff checksum passes",
      re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, verify: verhoeff },

    { kind: "PAN", ph: "[PAN]", tier: 1, severity: "high",
      ev: "PAN format (AAAAA9999A)",
      re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, verify: function () { return true; } },

    { kind: "Bank IFSC", ph: "[IFSC]", tier: 1, severity: "high",
      ev: "IFSC format (AAAA0XXXXXX)",
      re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, verify: function () { return true; } },

    { kind: "Passport number", ph: "[PASSPORT]", tier: 1, severity: "high",
      ev: "Indian passport format",
      re: /\b[A-PR-WY][0-9]{7}\b/g, verify: function () { return true; } },

    { kind: "Vehicle registration", ph: "[VEHICLE]", tier: 1, severity: "medium",
      ev: "Indian registration format",
      re: /\b[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{4}\b/g,
      verify: function () { return true; } },

    { kind: "Mobile number", ph: "[PHONE]", tier: 1, severity: "high",
      ev: "Indian mobile format",
      re: /(?:\+?91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g,
      verify: function (t) { return t.replace(/\D/g, "").length <= 12; } },

    { kind: "Email address", ph: "[EMAIL]", tier: 1, severity: "medium",
      ev: "Email format",
      re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      verify: function () { return true; } },

    { kind: "Date of birth", ph: "[DOB]", tier: 1, severity: "medium",
      ev: "Date pattern",
      re: /\b(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])[/-](?:19|20)\d{2}\b/g,
      verify: function () { return true; } },

    { kind: "Masked secret", ph: "[SECRET]", tier: 1, severity: "high",
      ev: "Masked input glyphs",
      re: /[\u2022\u00b7*]{4,}/g, verify: function () { return true; } }
  ];

  /* Returns every sensitive span inside a string, with offsets, so the caller
   * can highlight exactly the value rather than the whole line. Overlapping
   * matches are resolved in favour of whichever rule matched first. */
  function scan(text) {
    if (!text) return [];
    var hits = [];
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      r.re.lastIndex = 0;
      var m;
      while ((m = r.re.exec(text)) !== null) {
        if (!m[0].trim()) continue;
        if (!r.verify(m[0])) continue;
        var start = m.index, end = m.index + m[0].length;
        var clash = false;
        for (var j = 0; j < hits.length; j++) {
          if (start < hits[j].end && end > hits[j].start) { clash = true; break; }
        }
        if (clash) continue;
        hits.push({
          start: start, end: end, match: m[0],
          kind: r.kind, ph: r.ph, ev: r.ev, tier: r.tier, severity: r.severity
        });
      }
    }
    return hits.sort(function (a, b) { return a.start - b.start; });
  }

  /* Replaces every sensitive span with its placeholder, keeping the rest. */
  function redactText(text) {
    var hits = scan(text);
    if (!hits.length) return text;
    var out = "", cursor = 0;
    for (var i = 0; i < hits.length; i++) {
      out += text.slice(cursor, hits[i].start) + hits[i].ph;
      cursor = hits[i].end;
    }
    return out + text.slice(cursor);
  }

  return { scan: scan, redactText: redactText, RULES: RULES,
           verhoeff: verhoeff, luhn: luhn };
})();

if (typeof module !== "undefined" && module.exports) module.exports = OpaqueDetect;
