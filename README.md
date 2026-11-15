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

## New registrations keep arriving? Use "Watch"
Browsers can't read a path on their own, so you pick the file **once**:
1. In step 1 click **👁 Watch a file on this computer…** under the registrations box (and/or the bank box) and choose the CSV.
2. Choose how often to re-check (1 min … 6 hours). The page re-reads that same file on the timer and whenever you click **Check now**.
3. If the file changed, new teams are tagged **NEW**, statuses refresh, and a message says how many were found. Invites sent / added / manual overrides are kept.

Things to know:
- Works in **Chrome or Edge** only (other browsers: re-upload manually). The tab must stay open and the PC awake.
- The page can only see what is in the file. Google Forms doesn't update a downloaded CSV by itself: re-download and **overwrite the same file** (or save it under the same name) before the next check.
- After closing or reloading the tab you must pick the file again (the browser forgets file access for safety). Your data and progress are still restored.

## Coming back hours later
Open the page in the **same browser and at the same address** (the GitHub Pages link, or the same `index.html`; each address has its own saved data). Your previous teams and progress are restored. Then load the newer CSV (drag it in, or click Watch and pick it): teams that weren't there before get a **NEW** tag, and the **📨 Verified, not yet invited** chip lists exactly who still needs an invite.

## Closing the tab
Nothing runs in the background and nothing is ever sent automatically. Checking is instant, and every invite is opened by your own click. Progress (sent / added / overrides) is saved in the browser the moment it changes, so closing the tab loses nothing. "Sent" means *you opened the chat*, so if you closed WhatsApp before pressing Send, untick "sent" on that row.

## Final report (Excel)
**⬇ Download final Excel report** produces `registration_report_<date>.xlsx` with four sheets: *Summary*, *All teams* (status, bank evidence, invite time, added), *Invited* (exactly who was sent the link and when) and *Needs action* (everyone not verified, with the reason). It is built inside the page, so nothing is uploaded. The CSV button gives the same "All teams" data as plain CSV.

## Works with the NACDeC-X form layout
Columns are auto-detected: leader = *Team Member 1* (name, WhatsApp number, email), UTR = *Enter Transaction ID*, team size = number of filled *Team Member N: Name* columns, plus institution, city and the payment-proof Drive link (shown as "open in Drive" in the evidence panel, handy when a UTR is Pending). Typed prefixes such as "UTR No:" are ignored when matching.

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
js/app.js         interface, localStorage, links, file watching, report export
js/xlsx.js        tiny offline .xlsx writer
js/samples.js     fake demo data
sample/           fake data in the NACDeC-X form's exact column layout (registrations + bank statement)
tests/test.js     run: node tests/test.js
```

## Known limits
- One bank transfer per team (≥ fee). Split payments are not summed.
- UTR typos stay *Pending*; fix the UTR in the CSV and re-upload (progress is kept per phone+UTR).
- Phone numbers are assumed to be Indian (+91) unless you change the country code.
- CSV only (export Excel statements as CSV first).
- Watching a file needs Chrome/Edge and an open tab; there is no background service.
