# Invite Desk

A private, local-first desk for registration volunteers: check who has paid, then send each verified team leader
(and faculty mentor) the WhatsApp group invite — **once**, with a record of who has and hasn't been sent.

Everything runs in your browser. No server, no accounts, no uploads. Your data is encrypted with a passphrase
(AES-256-GCM, PBKDF2) and stored only in this browser.

## Daily use
1. **Registrations** – drop the latest CSV, *or* paste a Google Sheet link and press *Load / refresh*. New teams are flagged **NEW**.
2. **Payments** – drop the bank-statement PDF. Each new PDF is *added*; duplicates are ignored; a statement can be removed.
3. **Settings** – set the fee, your WhatsApp group invite link, and the messages (once).
4. **Send invites** – *Open WhatsApp* → press Send in WhatsApp → come back and press *Yes, I sent it*. That person can never be queued again.

## What the statuses mean
| Status | Meaning |
|---|---|
| Verified | Transaction ID found on a loaded statement and the amount ≥ fee |
| Awaiting statement | Registered after the newest statement ends — add the next statement |
| Amount short | Paid less than the fee |
| Check manually | ID isn't a 12-digit UPI reference (e.g. a NEFT/UTR code), or only a partial match. Look at the payment proof, then *Approve manually* with a note |
| Duplicate ID | Same transaction ID/payment used by two teams |
| Fix details | Leader's phone number or name is missing/invalid |

## Guard rails
- Only verified (or manually approved, with a written reason) teams can be invited.
- A phone number already in the sent list is blocked — across re-uploads, new statements and new sheet loads.
- One invite "in progress" at a time; nothing is recorded until you confirm it.
- Daily send limit (default 30) to protect your WhatsApp number; invite-link format check; auto-lock when idle.
- *Undo* exists but asks for confirmation and is logged in Activity.
- WhatsApp has no single-use links and can't be automated from a web page, so "sent" means *you pressed Send*.

## Running it
- **Hosted** (GitHub Pages): open the link; nothing to install.
- **On your PC**: double-click `start.bat`. PDF reading needs `http://`, so opening `index.html` directly (file://) won't read PDFs.
- Reading a PDF takes ~2 s per page (it uses OCR because bank PDFs printed from the browser are pictures, not text).
  A running balance check flags any row where a digit may have been misread.

## Backup
Settings ▸ *Download encrypted backup*. Clearing browser data deletes the vault, so back up regularly.
The backup is useless without your passphrase. There is no recovery if you forget it.

## Google Sheet link — privacy
Press *Publish to web* in Google Sheets and paste the CSV link. Anyone holding that link can read the sheet, so don't share
it, and un-publish when the event ends. The app only fetches it when you press the button.

## Development
`node tests/test.js` — unit tests with invented data. Libraries bundled in `vendor/`: pdf.js 3.11 (Apache-2.0),
tesseract.js 5 + core + English data (Apache-2.0), Plus Jakarta Sans (OFL). No CDNs.
