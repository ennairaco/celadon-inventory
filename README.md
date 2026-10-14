# Celadon Inventory (CelaCart)

A mobile-first web app for Ateneo Celadon's org room inventory. Members log in with their Ateneo ID, pick the project or department they're acting for, find where an item is stored, and log a **Borrow**, **Use up**, or **Return**. **Borrowed now** shows everything out of the org room, with overdue items in red, and a daily script sends reminders. Everything is written to a Google Sheet through one Apps Script.

Adapted from MEA's app ([David-GY/mea-id](https://github.com/David-GY/mea-id)). MEA's NFC ID Tracker and SUS Dashboard were removed because they're specific to MEA. The catalog, cart, offline queue, history, and installable-app (PWA) behaviour are kept.

## What changed from MEA

| Area | MEA | Celadon |
|---|---|---|
| Backends | Two scripts (ID tracker + room inventory) | One script: `apps-script/celadon-inventory.gs` |
| Login | Tracker sheet `MAIN` | Celadon's existing members sheet (or a `MEMBERS` tab) |
| Accountability | Free-text project | Required "acting for" project/department, allowed via department + `CORES` tab |
| Branding | Dark teal, Plus Jakarta Sans, MEA/SUS logos | Celadon navy `#003078` + orange `#f09b43`, Montserrat, Celadon mark (from ateneoceladon.com) |
| Requests | Borrow/consume/return left as cell comments | Logged as rows in `REQUESTS` with due dates. "Use up" deducts the quantity, and "Mark returned" clears a borrow |
| What's out | Read the comments | `BORROWED_NOW` tab + Borrowed-now screen + "N out" on items |
| Overdue | None | Daily trigger: highlights overdue rows and emails a digest (and optionally borrowers) |
| Storage areas | Free text | Dropdown from the `STORAGE_AREAS` tab |
| Projects | Hard-coded MEA list | `PROJECTS` tab (Celadon departments + projects pre-filled) |
| Contacts | SUS team | Placeholder; edit `CONTACTS` in `inventory.js` |

## Files

```text
index.html                         App shell (login, home, catalog, cart, checkout, history, settings, help)
inventory.js                       App logic, offline caches, request queue
inventory.css                      Celadon theme
apps-script/celadon-inventory.gs   The backend (paste into the sheet's Apps Script)
apps-script/catalog-seed-from-old-tracker.csv  186 items (org room + merch + MAF) from the 2026 tracker, ready to import into CATALOG
apps-script/storage-areas-seed.csv            11 cleaned-up storage area names for STORAGE_AREAS
tests/apps-script.test.js          Backend tests against a mock spreadsheet
sw.js, manifest.json, icons/, brand/   PWA + branding
```

## Setup

See [SETUP.md](SETUP.md).

## Tests

```bash
node tests/apps-script.test.js
```
