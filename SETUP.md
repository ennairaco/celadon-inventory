# Setting up Celadon Inventory

Takes about 20 minutes. You need edit access to the Celadon inventory Google Sheet and a GitHub account (for hosting).

## How it works (for members)

1. Log in with your 6-digit Ateneo ID. Only IDs in the member list can log in.
2. Pick who you're **acting for**. Every borrow or use-up is logged under a project or department, never personally. You can act for:
   - your own department (from the member list),
   - any project you're listed under in **CORES**,
   - anything, if you're an officer in **ACCESS**.
3. Find items in **CelaCart**, then check out as **Borrow**, **Use up**, or **Return**.
4. **Borrowed now** lists everything that's out, with overdue items in red. Anyone from that project/department (or the borrower) can tap **Mark returned**.

## 1. Prepare the sheet

1. Open the inventory sheet (your copy of MEA's sheet, or a blank one).
2. **Extensions → Apps Script.** Delete the starter code and paste in all of `apps-script/celadon-inventory.gs`. If the copied MEA sheet came with its own script files, delete those first: two `doGet` functions will silently break each other.
3. **Using the existing Celadon members sheet (recommended):** in Apps Script, open **Project Settings → Script properties** and add:
   - `MEMBERS_SPREADSHEET_ID`: the long ID in that sheet's URL (`/d/<this part>/edit`)
   - `MEMBERS_SHEET_NAME`: the tab name (leave out to use the first tab)

   The script finds columns by header name: `ID Number` / `ID No.` / `Student Number`, `Name` (or `First Name` + `Last Name`), `Department`, and `Email`. Department can be the code (`COMMPUB`) or the full name (*Communications and Publications*). Whoever deploys the script needs at least view access to that sheet.
4. Select `setupSheets` in the function dropdown, press **Run**, and approve the permissions prompt. It creates any missing tabs and columns and never deletes data:
   - **CATALOG**: one row per item. To start from the old 2026 tracker, import `apps-script/catalog-seed-from-old-tracker.csv` (File → Import → Upload → *Replace current sheet* while on CATALOG). That's 186 items, merch and MAF included. 72 of them have no storage area yet, so fill those in.
   - **STORAGE_AREAS**: the fixed list behind the CATALOG *Storage Area* dropdown. On first run it's filled from whatever CATALOG already uses, so import CATALOG first, or import `apps-script/storage-areas-seed.csv` here. Add a row to create a new area.
   - **MEMBERS**: only created when you're *not* using the external members sheet.
   - **ACCESS**: officers (`ADMIN` or `OFFICER`) plus their email. Officers can act for any project, and they receive the overdue digest.
   - **PROJECTS**: Celadon's 6 departments and 14 projects, already filled in. Untick `Active` to hide one. Set **Event End Date** so project borrows fall due the day after the event.
   - **CORES**: `ID Number | Name | Project | Role`. One row per core per project.
   - **REQUESTS**: written by the app. Don't edit the column headers.
   - **BORROWED_NOW**: a live, read-only view of everything still out, with overdue rows in red.
5. Reload the sheet. A **Celadon Inventory** menu appears.

## 2. Turn on overdue reminders

1. **Celadon Inventory → Turn on daily overdue reminders (8 AM)**, then approve the permissions prompt.
2. Script properties (all optional):
   - `NOTIFY_EMAILS`: who gets the daily digest (comma-separated). Defaults to the emails in ACCESS.
   - `EMAIL_BORROWERS = true`: also email the borrower and every core of that project.
   - `BORROW_DAYS`: how long a borrow can stay out when its project has no Event End Date (default 7).
   - `REMIND_EVERY_DAYS`: how often an overdue item is re-reminded (default 3).

Overdue rows are also highlighted in REQUESTS, and they show in red in the app.

## 3. Deploy the script

1. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone**.
2. Copy the `/exec` URL.
3. (Recommended) Add the script property `ACCESS_TOKEN` with any secret phrase. Members enter it once under the app's Settings.
4. After any script change: **Deploy → Manage deployments → Edit → New version**. The URL stays the same.

## 4. Point the app at it and host it on GitHub

1. Paste the `/exec` URL into `DEFAULT_INVENTORY_URL` in `inventory.js`.
2. Create a GitHub repo (e.g. under a Celadon account), push this folder, then **Settings → Pages → Deploy from branch → main / root**.
3. Share `https://<account>.github.io/<repo>/`. On phones: Settings → *Download Celadon App*, or Share → Add to Home Screen on iPhone.
4. After changing any app file, bump `CACHE_NAME` in `sw.js` (e.g. `cela-app-v3`) so phones pick up the new version.

## How requests are recorded

| App action | REQUESTS row | CATALOG |
|---|---|---|
| Borrow | Status `Pending`, with a `Due` date | Note on the Quantity cell. The app shows "N out" on the item |
| Use up | Status `Consumed` | Quantity reduced (turn off with `DEDUCT_ON_CONSUME = false`) |
| Return / Mark returned | The project's oldest matching `Pending` borrow flips to `Returned` (+ who, when) | Note on the Quantity cell |
