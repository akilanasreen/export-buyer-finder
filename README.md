# Export Buyer Finder

Seller enters a product + origin country → ranked destination markets (UN Comtrade) → shipping providers + destination buyer prospects (Google Places + business websites) → two separate PDF/CSV reports.

## Run
```bash
npm install            # installs pdf-lib (only dependency)
cp .env.example .env   # add keys (all optional if you only use Demo mode)
npm start              # http://localhost:3000
npm test               # in a 2nd terminal while the server runs: demo workflow + both downloads
```
Tick **Demo mode** on the home screen to try everything with clearly labelled fictional records. Demo mode never touches the network.

## Connect data sources
| Source | Used for | Setup |
|---|---|---|
| UN Comtrade | Ranked destination markets (annual exports, origin → each partner; "World" and aggregates excluded) | Free key at comtradedeveloper.un.org (subscribe to the *Comtrade API*), set `COMTRADE_API_KEY` |
| Google Places API (New) | Provider and buyer discovery | Google Cloud project, enable *Places API (New)*, billing on, set `GOOGLE_MAPS_API_KEY` |
| Business websites | Emails, phones, address, importer evidence | No key. The server fetches each business's own homepage / contact / about pages |
| Anthropic API (optional) | Extra product synonyms and local-language search phrases | `ANTHROPIC_API_KEY` |

Keys live only in `.env` on the server.

## How evidence and contact data work
* **Documented importer from [origin]**: a page on the business's own site mentions the product, importing and the origin country in the same passage. The excerpt and URL are shown and exported.
* **Product importer**: site says it imports the product; origin unconfirmed.
* **Potential buyer**: Maps listing only.
* Emails/phones are taken only from `mailto:`/`tel:` links or visible text on the business's site. Nothing is guessed; missing = "Not publicly listed". Each field's source URL is in the report.
* **Google terms**: Google restricts storing/exporting Places content (names, addresses, phones). By default (`EXPORT_MAPS_FIELDS=false`) reports contain only website-sourced fields; where none exists the report shows "Not publicly listed" and a Google Maps link. Review the current Google Maps Platform terms with your legal advisor before enabling `EXPORT_MAPS_FIELDS=true`. The server stores nothing: results live in your browser session and are posted back only to build a report.

## Test the downloads
1. Demo mode: cardamom, India → Select "United Arab Emirates".
2. In "Shipping Provider Report" click PDF and CSV. In "Buyer & Importer Contact Report" choose all or tick businesses + "Only selected", then PDF/CSV.
3. CSVs are UTF-8 with BOM (open directly in Excel); phone numbers are text so `+` prefixes survive. PDFs are A4 landscape and use Latin-1 text only (other scripts print as `?`; the CSV keeps full Unicode).
4. Change destination in the results header: both panels and both reports refresh.

## Known limits
* Services: no live bilateral services-trade source is wired in; the app labels this and asks for a manual destination.
* HS matching uses a built-in table for common goods, then Comtrade's HS list; ambiguous goods trigger a clarifying question.
* Cardamom is matched at HS heading 0908 (nutmeg, mace, cardamoms) because the 6-digit code changed in HS 2022; the broader category is shown.
