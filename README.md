# Currency Converter

**Live app: https://amiteze.github.io/currency-converter/**

A small web app for converting between your favorite currencies.

- Pick currencies from the full list (search by code or name) and they stay saved as your favorites.
- Type an amount in any favorite and all the others are converted as you type.
- Favorites, the last amount and the latest rates are kept in the browser's `localStorage`.

## Exchange rates

Rates come from the free, keyless [ExchangeRate-API](https://www.exchangerate-api.com) open endpoint
(`https://open.er-api.com/v6/latest/USD`), which updates once a day. If it is unreachable, the app falls back to
[fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api), served from the jsDelivr CDN.
All rates are quoted against USD and cross rates are derived from them. The app caches rates for an hour,
and the saved copy keeps working offline.

## Run locally

Plain HTML, CSS and JavaScript with no build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deployment

Every push to `main` runs `.github/workflows/pages.yml`, which publishes the site to the `gh-pages` branch.
GitHub Pages serves that branch (Settings → Pages → Deploy from a branch → `gh-pages` / root).
