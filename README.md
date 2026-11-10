# ARC Adaptive Rowing – Volunteer Sign-Up

A web app volunteers open on their phone to see which Adaptive sessions still need help, claim a spot, and cancel if plans change. It emails reminders automatically. It runs on one free Netlify site, set up the same way as the Winter Challenge app.

- **Volunteer page:** `https://YOUR-SITE.netlify.app`
- **Coordinator page:** `https://YOUR-SITE.netlify.app/admin`

## What it does

**Volunteers**
- See the next 4 weeks (adjustable) of real dates, built from the weekly schedule. Each spot shows the role, the athlete, and the bow level.
- Filter to *Open spots only*, or to *Rowing* / *Launch*.
- Tap **Sign up**. The first time, they give name, email, and (optionally) phone. Nothing else, no password.
- They get a confirmation email with a personal link. That link signs them in on any phone or computer. Lost it? **Email me my link** on the page.
- Cancel from **Your sign-ups**. If it's 3 days out or less, the coordinator is emailed automatically.
- The page won't let one person take two spots in the same session, and two people can't grab the same spot.

**Emails, every morning around 7 AM Eastern** (8 AM during daylight time)
- Volunteers signed up for a session **in 3 days** or **tomorrow** get a reminder.
- Volunteers who left *open-spot alerts* on get a list of spots still open in those same sessions.
- The coordinator gets a status email: who's on each of those sessions and what's still open.
- Cancelled sessions are skipped. Nobody gets more than one reminder email a day.

**Coordinator page** (passcode protected)
- **Upcoming:** every session with who's signed up (name, email, phone). Remove someone, assign someone who called or texted, cancel a session for weather or a holiday (optionally emailing the people on it), email the open-spot list to everyone now, download a CSV.
- **Volunteers:** list, add, delete, copy or email someone's personal link.
- **Weekly schedule:** edit the repeating schedule (day, time, boat, position, athlete, bow level). It starts with the schedule from the Adaptive spreadsheet; every athlete has the "Level 2 bow required" placeholder until you change it.
- **Settings & email:** program name, coordinator name and email, how many weeks are open, optional season start and end dates, send a test email, run today's reminders by hand.

The spreadsheet's "Week 1 / Week 2" tabs are replaced by actual dates, so there's nothing to reset each week.

## Setup (about 20 minutes)

### 1. Make a Gmail app password (for sending emails)
Use the Gmail account you want emails to come *from* (a program account like `arcadaptive@gmail.com` is best).

1. Turn on 2-Step Verification for that account: Google Account → Security.
2. Go to **myaccount.google.com/apppasswords**, create one named "Volunteer app", and copy the 16-character password.

Gmail allows about 500 emails a day, which is plenty here.

### 2. Put the code on GitHub
1. Create a new repository, e.g. `arc-adaptive-volunteers`. Leave "Add a README" unchecked.
2. Click **uploading an existing file**.
3. Unzip the download, open the `adaptive-volunteer-app` folder, select **everything inside it** (`netlify`, `public`, `netlify.toml`, `package.json`, `README.md`) and **drag** it into GitHub. Dragging keeps the subfolders.
4. **Commit changes.** The repo should show `netlify.toml` at the top level.

### 3. Connect it to Netlify
1. Netlify → **Add new site → Import an existing project → GitHub** → pick the repo.
2. Leave the build settings as they are (they come from `netlify.toml`). Click **Deploy**.
3. Rename the site if you like: Site configuration → **Change site name** (e.g. `arc-adaptive-volunteers`).

Drag-and-drop deploys **won't work**. They skip the backend, so sign-ups wouldn't save.

### 4. Add the settings (environment variables)
Netlify → Site configuration → **Environment variables** → Add:

| Key | Value |
|---|---|
| `ADMIN_PASSCODE` | A passcode for the coordinator page. Make it long. |
| `GMAIL_USER` | The Gmail address emails come from |
| `GMAIL_APP_PASSWORD` | The 16-character app password from step 1 |

Then **Deploys → Trigger deploy → Deploy site** so the new settings take effect.

### 5. Finish in the coordinator page
1. Open `https://YOUR-SITE.netlify.app/admin` and enter the passcode.
2. **Settings & email:** add the coordinator name and email, then **Send test email**.
3. **Weekly schedule:** check the sessions, change bow levels per athlete, save.
4. Open the volunteer page once yourself and sign up for a spot to see the confirmation email.
5. Share the volunteer page link with your volunteers.

## Good to know
- **Data** lives in Netlify Blobs on your site. Use **Download CSV** for a copy any time.
- **Volunteer privacy:** other volunteers only see a first name and last initial on taken spots. Emails and phone numbers appear only on the coordinator page.
- **Personal links** act like a key. Anyone with the link can change that person's sign-ups, so volunteers shouldn't forward their emails. If a link leaks, delete and re-add the volunteer.
- **Reminder time:** set in `netlify/functions/daily-reminders.mjs` (`0 12 * * *` is 12:00 UTC). For 6 AM Eastern use `0 11 * * *`.
- **Another email service:** instead of Gmail, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`.
- **Custom address:** if you use your own domain, also add `SITE_URL` (e.g. `https://volunteer.arcrowing.org`) so email links point there.
