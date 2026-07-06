# Privacy

iScale Etsy is local-first.

## What Stays Local

- Search terms entered into the popup.
- Discovered Etsy listing URLs.
- Scraped listing data.
- Imported CSV contents.
- Exported CSV files.
- Job history and local settings.

Data is stored in Chrome's local browser storage through IndexedDB.

## What Is Not Included

This public edition does not include:

- a hosted database
- account login
- cloud sync
- Supabase writes
- private iScaleLabs production endpoints
- telemetry or analytics

## CSV Files

CSV imports are parsed in your browser. CSV exports are generated in your
browser. The extension does not upload CSV files to a server.

If you enable auto-download, the extension writes CSV snapshots to your local
Downloads folder (or a subfolder you choose) automatically as listings
accumulate. This is still entirely local — nothing is transmitted anywhere.

## Etsy Pages

The extension runs on Etsy search and listing pages so it can collect the data
shown in your browser. You are responsible for using the tool in a way that
complies with Etsy's terms and applicable laws.
