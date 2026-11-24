---
"@hot-updater/console": patch
---

fix(console): fit the Insights compared-bundles table on phones

On a phone, Release health's compared-bundles table left its Bundle column about 50 px wide: a release's label and ID tail ran past the cell, and "Deployed" broke mid-word. When the card is narrower than the table needs, each compared bundle now shows as a row of its own, with its label, badges, and deployment on top and its counts underneath, each named as in the table. Wider cards keep the table as it was.
