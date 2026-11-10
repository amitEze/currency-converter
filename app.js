(() => {
  'use strict';

  const KEYS = { favorites: 'cc.favorites', base: 'cc.base', rates: 'cc.rates' };
  const DEFAULT_FAVORITES = ['USD', 'EUR', 'GBP', 'ILS'];
  const MAX_AGE_MS = 60 * 60 * 1000; // re-fetch rates when the saved copy is older than this
  const FETCH_TIMEOUT_MS = 8000;

  // Both providers are free, need no API key and allow cross-origin requests.
  // All rates are quoted against USD; cross rates are derived from them.
  const PROVIDERS = [
    {
      name: 'ExchangeRate-API',
      link: 'https://www.exchangerate-api.com',
      url: 'https://open.er-api.com/v6/latest/USD',
      parse(data) {
        if (data.result !== 'success') throw new Error('provider reported an error');
        return { rates: data.rates, updated: data.time_last_update_unix * 1000 };
      },
    },
    {
      name: 'fawazahmed0/exchange-api',
      link: 'https://github.com/fawazahmed0/exchange-api',
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json',
      parse(data) {
        // This feed also carries crypto and metals; keep ISO currencies only.
        const known = new Set(supportedCurrencies());
        const rates = {};
        for (const [key, value] of Object.entries(data.usd || {})) {
          const code = key.toUpperCase();
          if (known.size ? known.has(code) : /^[A-Z]{3}$/.test(code)) rates[code] = value;
        }
        return { rates, updated: Date.parse(data.date) };
      },
    },
  ];

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('rows');
  const emptyEl = $('empty');
  const statusEl = $('status');
  const refreshEl = $('refresh');
  const pickerEl = $('picker');
  const searchEl = $('search');
  const optionsEl = $('options');
  const noMatchEl = $('no-match');

  // ---------- storage ----------

  function read(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable (private mode, quota); the app still works for this visit.
    }
  }

  const isCode = (c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c);

  function loadFavorites() {
    const saved = read(KEYS.favorites);
    if (!Array.isArray(saved)) return [...DEFAULT_FAVORITES];
    return [...new Set(saved.filter(isCode))];
  }

  function loadBase(favorites) {
    const saved = read(KEYS.base);
    if (saved && favorites.includes(saved.code) && typeof saved.amount === 'string') {
      return { code: saved.code, amount: saved.amount };
    }
    return { code: favorites[0] || null, amount: '1' };
  }

  function loadRates() {
    const saved = read(KEYS.rates);
    return saved && saved.rates && typeof saved.rates === 'object' ? saved : null;
  }

  // ---------- state ----------

  let favorites = loadFavorites();
  let base = loadBase(favorites); // the currency the user typed into, and what they typed
  let rateData = loadRates(); // { rates, updated, fetchedAt, provider, link }
  let loading = false;
  let loadError = false;

  // ---------- currency metadata & formatting ----------

  function supportedCurrencies() {
    try {
      return Intl.supportedValuesOf('currency');
    } catch {
      return [];
    }
  }

  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames(['en'], { type: 'currency' });
  } catch {
    // Very old browsers: fall back to showing codes only.
  }

  function nameOf(code) {
    try {
      const name = displayNames && displayNames.of(code);
      return name && name !== code ? name : '';
    } catch {
      return '';
    }
  }

  const digitsCache = new Map();
  function minorDigits(code) {
    if (!digitsCache.has(code)) {
      let digits = 2;
      try {
        digits = new Intl.NumberFormat('en', { style: 'currency', currency: code })
          .resolvedOptions().maximumFractionDigits;
      } catch {
        // Unknown code: keep two decimals.
      }
      digitsCache.set(code, digits);
    }
    return digitsCache.get(code);
  }

  function formatConverted(value, code) {
    if (value === 0) return '0';
    const digits = minorDigits(code);
    let max = digits;
    if (Math.abs(value) < 1) {
      // Keep small amounts readable instead of rounding them to 0.00.
      const leadingZeros = Math.ceil(-Math.log10(Math.abs(value)));
      max = Math.min(Math.max(digits, leadingZeros + 3), 12);
    }
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: max,
    }).format(value);
  }

  // The amount the user typed: add thousands separators but keep their precision.
  function formatTyped(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 12 }).format(value);
  }

  function formatRate(value) {
    return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value);
  }

  // Returns a number, or null when the text is empty or not a valid amount.
  function parseAmount(text) {
    const cleaned = String(text).replace(/[,\s]/g, '');
    if (cleaned === '' || cleaned === '.') return null;
    if (!/^\d*\.?\d*$/.test(cleaned)) return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
  }

  function rateBetween(from, to) {
    const rates = rateData && rateData.rates;
    if (!rates || !rates[from] || !rates[to]) return null;
    return rates[to] / rates[from];
  }

  // ---------- favorites ----------

  function saveFavorites() {
    write(KEYS.favorites, favorites);
  }

  function saveBase() {
    write(KEYS.base, base);
  }

  function addFavorite(code) {
    if (favorites.includes(code)) return;
    favorites.push(code);
    if (!base.code) base = { code, amount: '1' };
    saveFavorites();
    saveBase();
    renderRows();
  }

  function removeFavorite(code) {
    if (!favorites.includes(code)) return;
    const remaining = favorites.filter((c) => c !== code);

    if (base.code === code) {
      // Hand the amount over to the next favorite, as it was displayed there,
      // so the visible numbers don't jump.
      const next = remaining[0] || null;
      const amount = parseAmount(base.amount);
      const rate = next && rateBetween(code, next);
      base = {
        code: next,
        amount: amount !== null && rate
          ? formatConverted(amount * rate, next).replace(/,/g, '')
          : '1',
      };
    }

    favorites = remaining;
    saveFavorites();
    saveBase();
    renderRows();
  }

  // ---------- rows ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderRows() {
    rowsEl.replaceChildren();

    for (const code of favorites) {
      const name = nameOf(code);
      const row = el('li', 'row');
      row.dataset.code = code;

      const cur = el('div', 'cur');
      cur.append(el('span', 'code', code), el('span', 'name', name));

      const field = el('div', 'field');
      const input = el('input', 'amount');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', `Amount in ${name || code}`);
      field.append(input, el('span', 'hint'));

      const remove = el('button', 'remove', '×');
      remove.type = 'button';
      remove.title = `Remove ${code}`;
      remove.setAttribute('aria-label', `Remove ${code} from favorites`);

      row.append(cur, field, remove);
      rowsEl.append(row);
    }

    emptyEl.hidden = favorites.length > 0;
    updateValues();
  }

  // Fill every row from the base amount. The field being typed in is left untouched.
  function updateValues() {
    const amount = parseAmount(base.amount);

    for (const row of rowsEl.children) {
      const code = row.dataset.code;
      const input = row.querySelector('.amount');
      const hint = row.querySelector('.hint');
      const isBase = code === base.code;
      row.classList.toggle('is-base', isBase);
      input.placeholder = '0';

      if (isBase) {
        hint.textContent = '';
        if (document.activeElement !== input) {
          input.value = amount !== null ? formatTyped(amount) : base.amount;
        }
        continue;
      }

      const rate = rateBetween(base.code, code);
      if (rate === null) {
        input.value = '';
        hint.textContent = '';
        if (rateData) input.placeholder = 'No rate';
        continue;
      }

      input.value = amount !== null ? formatConverted(amount * rate, code) : '';
      hint.textContent = `1 ${base.code} = ${formatRate(rate)} ${code}`;
    }
  }

  rowsEl.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.classList.contains('amount')) return;
    const cleaned = input.value.replace(/[^\d.,]/g, '');
    if (cleaned !== input.value) input.value = cleaned;
    base = { code: input.closest('.row').dataset.code, amount: cleaned };
    saveBase();
    updateValues();
  });

  rowsEl.addEventListener('focusin', (event) => {
    if (event.target.classList.contains('amount')) event.target.select();
  });

  rowsEl.addEventListener('focusout', (event) => {
    // Tidy the typed amount (thousands separators) once the field is left.
    if (event.target.classList.contains('amount')) setTimeout(updateValues);
  });

  rowsEl.addEventListener('click', (event) => {
    const button = event.target.closest('.remove');
    if (button) removeFavorite(button.closest('.row').dataset.code);
  });

  // ---------- picker ----------

  function allCurrencies() {
    const fromRates = rateData ? Object.keys(rateData.rates) : [];
    const codes = fromRates.length ? fromRates : supportedCurrencies();
    // Keep saved favorites listed even if the current feed doesn't carry them.
    return [...new Set([...codes, ...favorites])].sort();
  }

  function renderOptions() {
    const query = searchEl.value.trim().toLowerCase();
    const matches = [];

    for (const code of allCurrencies()) {
      const name = nameOf(code);
      const codeLower = code.toLowerCase();
      let rank;
      if (!query) rank = 2;
      else if (codeLower.startsWith(query)) rank = 0;
      else if (codeLower.includes(query) || name.toLowerCase().includes(query)) rank = 1;
      else continue;
      matches.push({ code, name, rank });
    }
    matches.sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));

    optionsEl.replaceChildren();
    for (const { code, name } of matches) {
      const selected = favorites.includes(code);
      const button = el('button', 'option');
      button.type = 'button';
      button.dataset.code = code;
      button.setAttribute('aria-pressed', String(selected));
      const star = el('span', 'star', selected ? '★' : '☆');
      star.setAttribute('aria-hidden', 'true');
      button.append(el('span', 'code', code), el('span', 'name', name), star);
      const item = el('li');
      item.append(button);
      optionsEl.append(item);
    }
    noMatchEl.hidden = matches.length > 0;
  }

  function toggleOption(button) {
    const code = button.dataset.code;
    const selected = !favorites.includes(code);
    if (selected) addFavorite(code);
    else removeFavorite(code);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('.star').textContent = selected ? '★' : '☆';
  }

  $('add').addEventListener('click', () => {
    searchEl.value = '';
    renderOptions();
    pickerEl.showModal();
    optionsEl.scrollTop = 0;
    searchEl.focus();
  });

  $('picker-close').addEventListener('click', () => pickerEl.close());

  pickerEl.addEventListener('click', (event) => {
    if (event.target === pickerEl) pickerEl.close(); // click on the backdrop
  });

  searchEl.addEventListener('input', renderOptions);

  searchEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = optionsEl.querySelector('.option');
    if (first && searchEl.value.trim()) toggleOption(first);
  });

  optionsEl.addEventListener('click', (event) => {
    const button = event.target.closest('.option');
    if (button) toggleOption(button);
  });

  // ---------- rates ----------

  function cleanRates(raw) {
    const rates = {};
    for (const [code, value] of Object.entries(raw || {})) {
      if (isCode(code) && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        rates[code] = value;
      }
    }
    return rates;
  }

  async function fetchFrom(provider) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(provider.url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = provider.parse(await response.json());
      const rates = cleanRates(parsed.rates);
      if (!rates.USD || Object.keys(rates).length < 2) throw new Error('no usable rates');
      return {
        rates,
        updated: Number.isFinite(parsed.updated) ? parsed.updated : Date.now(),
        fetchedAt: Date.now(),
        provider: provider.name,
        link: provider.link,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshRates() {
    if (loading) return;
    loading = true;
    loadError = false;
    renderStatus();

    let fresh = null;
    for (const provider of PROVIDERS) {
      try {
        fresh = await fetchFrom(provider);
        break;
      } catch (error) {
        console.warn(`Rates from ${provider.name} failed:`, error);
      }
    }

    loading = false;
    if (fresh) {
      rateData = fresh;
      write(KEYS.rates, rateData);
      updateValues();
      if (pickerEl.open) renderOptions();
    } else {
      loadError = true;
    }
    renderStatus();
  }

  function renderStatus() {
    statusEl.replaceChildren();
    statusEl.classList.toggle('is-error', loadError && !rateData);
    refreshEl.disabled = loading;
    refreshEl.textContent = loadError ? 'Try again' : 'Refresh';

    if (loading && !rateData) {
      statusEl.textContent = 'Loading exchange rates…';
      return;
    }
    if (!rateData) {
      statusEl.textContent = loadError
        ? 'Couldn’t load exchange rates. Check your connection.'
        : '';
      return;
    }

    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(rateData.updated));
    const source = el('a', '', rateData.provider);
    source.href = rateData.link;
    source.target = '_blank';
    source.rel = 'noopener';
    const prefix = loading ? 'Updating… rates from ' : 'Rates from ';
    const suffix = loadError ? ` (${when}). Couldn’t update, showing saved rates.` : ` · ${when}`;
    statusEl.append(prefix, source, suffix);
  }

  refreshEl.addEventListener('click', refreshRates);

  // Pick up newer rates when a long-open tab is brought back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isStale()) refreshRates();
  });

  function isStale() {
    return !rateData || Date.now() - (rateData.fetchedAt || 0) > MAX_AGE_MS;
  }

  // ---------- start ----------

  renderRows();
  renderStatus();
  if (isStale()) refreshRates();
})();
