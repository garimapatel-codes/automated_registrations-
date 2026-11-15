# Registration Verifier (local-only)

Upload the Google Form CSV and the bank statement CSV. The page matches each team's UTR to a bank credit, checks the amount (₹8000 by default), and gives you a WhatsApp link per verified team leader.

## How to run
Double-click **`index.html`**. It runs in any modern browser, needs no install and no internet.

## Privacy
- No server, no accounts, no analytics, no CDN files.
- The page ships with a Content-Security-Policy that makes the browser **refuse every network request** (fetch, XHR, WebSocket, images, fonts, iframes, forms). Data cannot be sent out even by a bug.
- Data is kept in the browser's `localStorage` only when "Remember files & progress" is ticked. Untick it, or press **Clear all data**, to remove it.
- Only link-opening touches the network: when you click *Send invite* the browser opens `wa.me/<number>` (that is WhatsApp itself, not this app).
- Do not host this page on a shared computer's public folder, and clear data when the event is over.

## Workflow
1. Upload both CSVs (or press *Try with sample data*).
2. Check the auto-detected columns (step 2). Bank statements with account details above the table are handled; change *Header row no.* if needed.
3. Set fee, max team size, and choose the action button mode:
   - **wa.me link only** — opens a blank chat with the leader.
   - **Ready-to-send invite message** — opens the chat with your message and the group invite link filled in; you press Send.
4. Use the status bar (always visible) to filter. Open **Show evidence** on any row to see the exact bank row that was matched (UTR highlighted) before you invite anyone.
5. *Send to next verified leader ▶* walks through verified, not-yet-invited leaders one click at a time.
6. Tick **added** once the leader is in the group. Progress survives a page reload.

## Statuses
| Status | Meaning |
|---|---|
| ✅ Verified | UTR found as a bank credit, amount ≥ fee |
| ⚠️ Underpaid | UTR found, amount below fee |
| ⏳ Pending | UTR not in the bank file (yet) — upload a fresher statement or check for a typo |
| 🚫 Duplicate | Same UTR or same leader phone in more than one registration |
| 🔍 Needs review | No UTR, bad phone, too many members, partial-text match, or UTR in several bank credits |
| Manual | You can force *Verified* / *Rejected* per team; it is labelled "(manual)" everywhere |

## "One-time" invite links
WhatsApp has no single-use invite links, and a page that never contacts a server cannot create them. Do this instead: in the WhatsApp group settings turn on **Approve new participants**. Anyone using the link only *requests* to join; you approve just the people shown as Verified (use **Copy phones to approve**). The app also marks each invite as *sent* and asks before you send a second one.

## Files
```
index.html        page + privacy policy (CSP)
css/style.css
js/core.js        CSV parsing + verification logic (no DOM; unit-tested)
js/app.js         interface, localStorage, links
js/samples.js     fake demo data
sample/           the same fake data as CSV files
tests/test.js     run: node tests/test.js
```

## Known limits
- One bank transfer per team (≥ fee). Split payments are not summed.
- UTR typos stay *Pending*; fix the UTR in the CSV and re-upload (progress is kept per phone+UTR).
- Phone numbers are assumed to be Indian (+91) unless you change the country code.
- CSV only (export Excel statements as CSV first).
