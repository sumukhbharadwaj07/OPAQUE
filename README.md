# Opaque

A browser extension for **SIH26171 — On-device visual perception for light-weight
browser agents** (ISRO).

The screen is read on your own machine. Anything sensitive is covered **before**
a screenshot is ever taken, and only placeholders are sent to the reasoning
model. You can then ask follow-up questions about the page, and the model keeps
the context without ever receiving the values.

---

## Install (2 minutes)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Choose this `opaque` folder
5. Open any ordinary website and click the Opaque icon

It will not run on `chrome://` pages. That is a browser restriction, not a bug.

---

## Using it

- **Read this screen** — scans the page, covers sensitive values, captures the
  already-redacted screen, and builds the description that will be sent.
- **Chat** — ask anything. The screen description is attached to your first
  question only; after that the conversation continues normally and the model
  still remembers the page.
- **Found** — every detected item, with the tier that caught it and the evidence.
- **Sent** — the exact text that leaves your machine. Show this to anyone who
  doubts the privacy claim.

By default the reasoning server is **Mock**, which needs no internet and never
fails. Use that for a live demo.

### Gemini

Settings → Reasoning server → Gemini API. Paste your own key, then press
**Test key and list models**. That confirms the key and fills the model box with
one your key can actually call, which avoids guessing at model names.

### Ollama (fully offline)

```bash
ollama serve
ollama pull llama3.2
OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

The last line matters: without it the browser blocks the request.

---

## How detection works

| Tier | Method | Examples | Cost |
|---|---|---|---|
| 0 | The page's own structure | `input[type="password"]`, `autocomplete="cc-number"` | free, exact |
| 1 | Checksums and strict formats | Aadhaar (Verhoeff), cards (Luhn), PAN, IFSC, phone, email | microseconds |
| 2 | Florence-2 OCR | text inside images and canvas | hundreds of ms |

Tiers 0 and 1 run always. Tier 2 is off by default because the DOM already
provides the text with exact positions — running a vision model over text you
can simply read would cost accuracy, memory and time, all three of which are
scored.

**Password values are never read.** Only the existence of the field is recorded.

---

## Optional: enabling Florence-2

Extension pages cannot load scripts from a CDN, so the library must be present
locally. From inside the `opaque` folder:

```bash
curl -L -o lib/transformers.min.js \
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js"
```

Then reload the extension, open Settings, tick **Also read text inside images**,
and press **Load Florence-2**. The weights are a few hundred megabytes on first
use and are cached afterwards.

If the download 404s, the version has moved — check the current one on npm and
adjust the URL.

---

## Files

```
manifest.json     permissions, entry points, content security policy
background.js     service worker: routes messages, captures the screen
content.js        runs in the page: scanning, redaction overlay, page summary
lib/detect.js     checksums and pattern rules, shared by both contexts
sidepanel.html    the interface
sidepanel.css     styling
sidepanel.js      conversation, optional OCR, calls to the reasoning server
```

---

## Known gaps

These are real and worth stating openly rather than hiding.

- **Names and addresses are not detected.** They have no checksum and no fixed
  format, so they need a trained model. Fine-tuning a small NER model on Indian
  names and addresses is the single most valuable thing left to build, and it is
  the part you can honestly call your own contribution.
- **Faces are not detected.** Tier 3 is not implemented.
- **No accuracy numbers yet.** The rubric scores detection recall and precision.
  You need a labelled set of screenshots and real measurements.
- **Actions are limited to scroll and highlight**, and are never performed
  without you pressing the button. A model should not be able to submit someone's
  form on its own.
- **Written without being run.** The machine that produced this could not install
  Chrome. Expect to fix small things. Open the service worker console from
  `chrome://extensions` and the side panel console with right-click → Inspect.

---

## What to say when demonstrating it

Open a form with real-looking details. Press **Read this screen** — the values
disappear under black boxes. Switch to the **Sent** tab and read it aloud: the
labels are all there, the values are all placeholders.

Then ask a follow-up question and let the model answer correctly anyway. That is
the whole argument: structure is enough, values are not needed.

Then say the part most teams miss — the capture happens *after* the boxes are
painted, so an unredacted screenshot of the page never exists anywhere in the
extension.
