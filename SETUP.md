# Setting up Celadon Inventory

Takes about 15 minutes. You need edit access to the **'26-'27 Inventory Tracker** Google Sheet.

## How it works (for members)

1. Log in with your 6-digit Ateneo ID. Only IDs in the member list can log in.
2. Pick the **project or department** you're borrowing or using items for. Every borrow or use-up is logged under one, never personally. Anyone can pick any of them; it starts on your own department.
3. Find items in **CelaCart** (everything in Inventory, Celamerch and Consumables), then check out as **Borrow**, **Use up**, or **Return**.
4. **Borrowed now** lists what's out, with overdue items in red. Anyone can tap **Mark returned** when an item comes back; the sheet records who did.

## What the app does to your sheet

| Tab | What the app does |
|---|---|
| Inventory | Reads every row. Changes only these cells: **Qty** (lowered on "Use up"), **Status** (`Out` when every unit is borrowed, back to `In Storage` when returned, `Used Up` at 0), and a note on the Qty cell recording who did what. Rows marked *Returned to Owner* or *Used Up* are hidden in the app. |
| Celamerch | Reads rows that have a Count. "Use up" lowers **Count** (e.g. merch given out). |
| Consumables | Same as Inventory. Items with an **Expiry Date** within 14 days get flagged. |
| MEMBERS, ACCESS, PROJECTS, REQUESTS, BORROWED_NOW | New tabs that `setupSheets` adds for the app. |

The app never adds or deletes rows in Inventory, Celamerch or Consumables. Adding new items is still done in the sheet.

## 1. Add the script

1. Open the **'26-'27 Inventory Tracker** sheet, then **Extensions → Apps Script**.
2. Delete the starter code, paste in all of `apps-script/celadon-inventory.gs`, and save.
3. Pick **`setupSheets`** in the function dropdown, then press **Run**. Approve the permissions prompt; Google will warn that the app isn't verified, so click *Advanced → Go to project*.
4. Back in the sheet, fill in the new tabs:
   - **MEMBERS**: `ID Number | Name | Department | Position | Email`. Add yourself first so you can test. Later you can switch to the real members sheet instead (see below).
   - **ACCESS**: officers (`ADMIN` or `OFFICER`) and their email. They receive the daily email.
   - **PROJECTS**: already filled with the 6 departments, General, and the 14 events (same names as the Inventory tab's Event column). Set **Event End Date** so project borrows fall due the day after the event. Untick **Active** to hide a project.
   - (No CORES tab needed: any member picks the project or department when borrowing.)
5. Reload the sheet. A **Celadon Inventory** menu appears.

**Later, to use the existing members sheet instead of MEMBERS:** in Apps Script, open **Project Settings → Script properties** and add `MEMBERS_SPREADSHEET_ID` (the long ID in that sheet's URL) and `MEMBERS_SHEET_NAME` (its tab name). Columns are found by name: ID Number / Student Number, Name (or First + Last Name), Department, Email.

## 2. Deploy it

1. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone**.
2. Copy the `/exec` URL and send it to whoever maintains the app code. It goes into `DEFAULT_INVENTORY_URL` in `inventory.js`, then gets pushed to GitHub.
3. (Recommended) Add the script property `ACCESS_TOKEN` with any secret phrase. Members enter it once under the app's Settings.
4. After any script change: **Deploy → Manage deployments → Edit → New version**. The URL stays the same.

## 3. Turn on daily reminders

**Celadon Inventory → Turn on daily reminders (8 AM)**. Each morning the script:
- highlights overdue borrows in REQUESTS,
- emails a digest of overdue borrows and expiring Consumables to the ACCESS emails, or to `NOTIFY_EMAILS` if you set it.

Optional script properties:
- `EMAIL_BORROWERS = true`: also email each borrower.
- `BORROW_DAYS` (default 7): how long a borrow can stay out when its project has no event end date.
- `REMIND_EVERY_DAYS` (default 3): how often an overdue item is re-reminded.
- `EXPIRY_WARN_DAYS` (default 14): how early expiring Consumables are flagged.

## App hosting

The app is on GitHub Pages: https://ennairaco.github.io/celadon-inventory/ (repo `ennairaco/celadon-inventory`). After changing any app file, bump `CACHE_NAME` in `sw.js` so phones pick up the new version.
