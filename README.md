# promo-share — Faculty share page

Static GitHub Pages site for **Promo Share Tracker** (Ganesh College of Engineering, Salem).
Each faculty member opens a personal link like:

```
https://<username>.github.io/promo-share/?t=TOKEN
```

and shares the day's admission poster / video to their **WhatsApp Status** in a few taps:
**Share → WhatsApp → My status → Send**.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell (header, main area, toast) |
| `style.css` | Mobile-first styles, no framework |
| `app.js` | Loads data from the API, preloads media as a `File`, calls `navigator.share`, logs every action with an offline retry queue, optional proof upload |
| `config.js` | **Edit this:** paste the Faculty API URL (Apps Script Deployment 1, ends with `/exec`) |
| `media/` | Posters and videos. The Admin Panel commits new files here automatically through the GitHub API |

## One-time setup

1. Upload all files of this folder to the root of the repository `promo-share` (keep `media/.gitkeep`).
2. Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
3. Edit `config.js` → set `API_URL` to the Faculty API URL → Commit.
4. Open `https://<username>.github.io/promo-share/` — you should see “Link not valid” (no token). That is correct.

## Why this page is on GitHub Pages (and not Apps Script)

`navigator.share()` is blocked inside the Apps Script HtmlService iframe (“Permission denied”).
A normal web page on GitHub Pages can use the Web Share API, so the faculty page lives here and
Apps Script is used only as the JSON API + Admin Panel.

## API used

| Call | Request | Response |
|---|---|---|
| Init | `GET API_URL?action=init&t=TOKEN` | `{ok, college, faculty:{name, dept}, items:[{itemCode, title, type, caption, mediaUrl, sharedByMe}], proofEnabled, notices:[{id, message, details, priority, end, daysLeft, linkUrl, linkText, needsAck, done}]}` |
| Log | `POST {"action":"log","t":TOKEN,"itemCode":"P001","event":"share_success","device":"Android","browser":"Chrome"}` (optional `itemCodes:[…]`, `clientTs`) | `{ok:true}` |
| Proof | `POST {"action":"proof","t":TOKEN,"itemCode":"P001","views":123,"imageBase64":"…"}` | `{ok:true, url}` |
| Notice | `POST {"action":"notice","t":TOKEN,"noticeId":"N001","event":"seen"\|"done","device":"Android"}` | `{ok:true}` (duplicates ignored) |

POST bodies are sent as `Content-Type: text/plain;charset=utf-8` with a JSON string — this avoids the CORS pre-flight that Apps Script cannot answer.

## Notice bar

Notices are created in the Admin Panel → **📢 Notices** tab and saved in the `Notices` sheet.
On this page they appear as a sticky bar under the header:

- one notice at a time, urgent first; long messages scroll slowly, then the next notice shows
- tapping the bar opens the full list (bottom sheet) with details, link button and **Mark as done**
- a new **urgent** notice opens the list once by itself
- “Mark as done” needs a second tap to confirm; finished tasks leave the bar
- `seen` / `done` events use the same offline retry queue as the share logs
- respects the phone's *reduce motion* setting (no scrolling or fades)

## Notes

- “Shared ✓” means the phone’s share sheet completed. The system cannot confirm the item was actually posted to Status, so the word **Shared** (never “Posted”) is used everywhere.
- A newly uploaded media file needs about **1 minute** before GitHub Pages serves it. Until then the card shows “Media is being published” with a Retry button.
- Media files are public (they are promotional posters). Personal data never touches this repository.
