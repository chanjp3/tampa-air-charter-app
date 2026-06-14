# TAC Desk — staff app (add-on to TAC Members)

Lives at `/staff/` inside the **same** members Pages project — it shares the same
database, so client requests flow straight to staff. Employees get a push
notification the instant a client submits a request, and can send a quote
(with a booking link) right from their phone.

## What was added
```
functions/api/staff.js     staff auth, inbox, quote+booking, push subscribe
functions/api/_push.js     web-push sender (VAPID + payload encryption)
staff/index.html           the employee app
staff/sw.js                service worker w/ push + notification click
staff/manifest.webmanifest
schema_staff.sql           extra tables (also appended to schema.sql)
```

## Setup (after the members app is already running)

**1. Add the staff tables.** In the D1 console, run each statement from
`schema_staff.sql` (5 statements — same one-at-a-time rule as before).

**2. Add environment variables** (Pages project → Settings → Variables):

| Variable | Value |
|---|---|
| `STAFF_EMAILS` | comma-separated allowlist, e.g. `chandler@willsmithaviation.com,will@willsmithaviation.com,ericka@...` — only these can sign into the desk app |
| `VAPID_PUBLIC` | from `vapid.txt` (provided) |
| `VAPID_PRIVATE` | from `vapid.txt` — add as a **Secret** |
| `PUSH_SUBJECT` | `mailto:charter@willsmithaviation.com` (any contact email) |

(You already have `RESEND_API_KEY`, `DESK_EMAIL`, etc. from the members setup.)

**3. Redeploy.** Bindings/vars take effect on the next deploy.

## Using it
- Staff open `/staff/`, sign in with an allowlisted email + code.
- Tap **Enable notifications** once per device (and install to home screen — on
  iPhone, push only works *after* "Add to Home Screen").
- When a client sends a request: every subscribed staff device buzzes with
  "New quote request · TPA → ASE · Jane Doe". Tapping it opens the inbox.
- In the request, fill amount + message + **booking link** (Stripe payment link,
  contract URL, whatever), tap **Send quote**. The client gets it in their app
  and by email, booking link included.

## Notes
- Staff sign-in is fully separate from client sign-in (different cookie, different
  allowlist) — a client email can't reach the desk app and vice-versa.
- Web push works on Android/Chrome and desktop immediately. iOS Safari supports it
  only for installed (home-screen) PWAs, iOS 16.4+.
- "Send test notification" at the bottom of the inbox confirms a device is wired up.
- Dead subscriptions (uninstalled apps) are pruned automatically on send.
