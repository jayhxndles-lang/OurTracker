import type { ForexRateCache, QuoteCache } from './types';
import { loadTickerHistory, saveTickerHistory, type CachedTickerHistory } from './firebase';

// Finnhub API tokens
const FINNHUB_KEYS = [
  'dag9ggpr01quf8mtbus0dag9ggpr01quf8mtbusg',
  'dag9gt9r01quf8mtc0d0dag9gt9r01quf8mtc0dg',
  'dag9h9hr01quf8mtc1rgdag9h9hr01quf8mtc1s0',
];

// Twelve Data API keys
const TWELVE_DATA_KEYS = [
  'c680e1388d9d40a28b1e2b3649aafefb',
  '51160f2e1e2448c386f09c74b218d6ff',
  '731995a5bbac474ebc542740d686c3f8',
];

let finnhubIndex = 0;
let twelveDataIndex = 0;

function getNextFinnhubKey(): string {
  const key = FINNHUB_KEYS[finnhubIndex % FINNHUB_KEYS.length];
  finnhubIndex++;
  return key;
}

function getNextTwelveDataKey(): string {
  const key = TWELVE_DATA_KEYS[twelveDataIndex % TWELVE_DATA_KEYS.length];
  twelveDataIndex++;
  return key;
}

// Memory and localStorage caches
const QUOTE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FOREX_CACHE_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours (within 4-6h cache window)

const quotesCache: Map<string, QuoteCache> = new Map();
let forexCache: ForexRateCache | null = null;
const monthChangeCache: Map<string, { pct: number; timestamp: number }> = new Map();
const currencyRatesCache: Map<string, { rate: number; timestamp: number }> = new Map();

// Initialize cache from localStorage if available
try {
  const savedQuotes = localStorage.getItem('jf_quotes_cache_v2');
  if (savedQuotes) {
    const parsed = JSON.parse(savedQuotes);
    Object.entries(parsed).forEach(([ticker, data]) => {
      quotesCache.set(ticker, data as QuoteCache);
    });
  }
  const savedMonthChange = localStorage.getItem('jf_month_change_cache_v2');
  if (savedMonthChange) {
    const parsed = JSON.parse(savedMonthChange);
    Object.entries(parsed).forEach(([ticker, data]) => {
      monthChangeCache.set(ticker, data as { pct: number; timestamp: number });
    });
  }
  const savedForex = localStorage.getItem('jf_forex_cache');
  if (savedForex) {
    forexCache = JSON.parse(savedForex);
  }
} catch {
  // localStorage may be disabled or restricted
}

function saveQuotesToLocalStorage() {
  try {
    const obj: Record<string, QuoteCache> = {};
    quotesCache.forEach((v, k) => {
      // only keep fresh items
      if (Date.now() - v.timestamp < QUOTE_CACHE_TTL_MS * 4) {
        obj[k] = v;
      }
    });
    localStorage.setItem('jf_quotes_cache_v2', JSON.stringify(obj));
  } catch {}
}

function saveMonthChangeToLocalStorage() {
  try {
    const obj: Record<string, { pct: number; timestamp: number }> = {};
    monthChangeCache.forEach((v, k) => {
      obj[k] = v;
    });
    localStorage.setItem('jf_month_change_cache_v2', JSON.stringify(obj));
  } catch {}
}

function saveForexToLocalStorage(cache: ForexRateCache) {
  try {
    localStorage.setItem('jf_forex_cache', JSON.stringify(cache));
  } catch {}
}

/**
 * Common known ticker aliases mapping to reliable market symbols
 */
export const TICKER_ALIASES: Record<string, { primarySymbol: string; fallbackSymbols: string[]; currency: string }> = {
  '000660': { primarySymbol: '000660.KS', fallbackSymbols: ['HY9.DE', 'HXSCF'], currency: 'KRW' },
  '000660.KS': { primarySymbol: '000660.KS', fallbackSymbols: ['HY9.DE', 'HXSCF'], currency: 'KRW' },
  '000660.KQ': { primarySymbol: '000660.KS', fallbackSymbols: ['HY9.DE', 'HXSCF'], currency: 'KRW' },
  'KR7000660001': { primarySymbol: '000660.KS', fallbackSymbols: ['HY9.DE', 'HXSCF'], currency: 'KRW' },
  'US78463V1070': { primarySymbol: 'HXSCF', fallbackSymbols: ['000660.KS', 'HY9.DE'], currency: 'USD' },
  'HY9': { primarySymbol: 'HY9.DE', fallbackSymbols: ['000660.KS', 'HXSCF'], currency: 'EUR' },
  'HY9.DE': { primarySymbol: 'HY9.DE', fallbackSymbols: ['000660.KS', 'HXSCF'], currency: 'EUR' },
  'HXSCF': { primarySymbol: 'HXSCF', fallbackSymbols: ['000660.KS', 'HY9.DE'], currency: 'USD' },
  '005930': { primarySymbol: '005930.KS', fallbackSymbols: ['SSUN.DE', 'SMSN.L'], currency: 'KRW' },
  '005930.KS': { primarySymbol: '005930.KS', fallbackSymbols: ['SSUN.DE', 'SMSN.L'], currency: 'KRW' },
};

/**
 * Detect currency of a ticker symbol or explicit string.
 */
export function detectTickerCurrency(ticker: string, explicitCurrency?: string): string {
  if (explicitCurrency) {
    const exp = explicitCurrency.trim().toUpperCase();
    if (exp === 'EUR' || exp.includes('EUR') || exp === '€' || exp.includes('€')) return 'EUR';
    if (exp === 'USD' || exp.includes('USD') || exp === '$' || exp.includes('$')) return 'USD';
    if (exp === 'KRW' || exp.includes('KRW') || exp === '₩' || exp.includes('₩')) return 'KRW';
    if (exp === 'GBP' || exp.includes('GBP') || exp === '£' || exp.includes('£')) return 'GBP';
    if (exp === 'CHF' || exp.includes('CHF')) return 'CHF';
    if (exp === 'JPY' || exp.includes('JPY') || exp === '¥') return 'JPY';
  }

  const norm = ticker.trim().toUpperCase();
  if (TICKER_ALIASES[norm]) {
    return TICKER_ALIASES[norm].currency;
  }

  if (
    norm.endsWith('.DE') ||
    norm.endsWith('.F') ||
    norm.endsWith('.PA') ||
    norm.endsWith('.AS') ||
    norm.endsWith('.MI') ||
    norm.endsWith('.MC')
  ) {
    return 'EUR';
  }

  if (norm.endsWith('.KS') || norm.endsWith('.KQ') || norm.endsWith('.KRX') || /^\d{6}$/.test(norm)) {
    return 'KRW';
  }

  if (norm.endsWith('.L') || norm.endsWith('.LON')) {
    return 'GBP';
  }

  if (norm.endsWith('.SW') || norm.endsWith('.VX')) {
    return 'CHF';
  }

  if (norm.endsWith('.T') || norm.endsWith('.JP')) {
    return 'JPY';
  }

  return 'USD';
}

/**
 * Determine if a ticker is USD-denominated.
 * Prioritizes explicit currency from file/data over ticker suffixes.
 */
export function isTickerUsd(ticker: string, explicitCurrency?: string): boolean {
  const curr = detectTickerCurrency(ticker, explicitCurrency);
  return curr === 'USD';
}

/**
 * Fetch exchange rate from any currency to EUR (ECB rates via Frankfurter).
 */
export async function getCurrencyToEurRate(fromCurrency: string): Promise<number | null> {
  const from = fromCurrency.trim().toUpperCase();
  if (from === 'EUR') return 1;

  const now = Date.now();
  const cached = currencyRatesCache.get(from);
  if (cached && now - cached.timestamp < FOREX_CACHE_TTL_MS && cached.rate > 0) {
    return cached.rate;
  }

  if (from === 'USD') {
    return getUsdToEurRate();
  }

  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=EUR`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.rates && typeof data.rates.EUR === 'number') {
        const rate = parseFloat(data.rates.EUR);
        if (!isNaN(rate) && rate > 0) {
          currencyRatesCache.set(from, { rate, timestamp: now });
          console.log(`[Forex - Frankfurter (ECB)] Loaded ${from}/EUR rate: ${rate}`);
          return rate;
        }
      }
    }
  } catch (err) {
    console.warn(`[Forex - Frankfurter] Failed to fetch ${from}/EUR rate:`, err);
  }

  // Backup fallback for common currencies if API is temporarily unavailable
  if (from === 'KRW') return 0.00066;
  if (from === 'JPY') return 0.0062;
  if (from === 'GBP') return 1.18;
  if (from === 'CHF') return 1.06;

  return null;
}

/**
 * Fetch USD to EUR exchange rate with 5-hour caching (ECB updates once per business day).
 * Primary source: Frankfurter API (https://api.frankfurter.app) - free, public, official ECB rates.
 * Backup source: Twelve Data exchange_rate endpoint.
 * Integrity: If both fail and cache is expired, returns null (never invent rates).
 */
export async function getUsdToEurRate(): Promise<number | null> {
  const now = Date.now();
  if (forexCache && now - forexCache.timestamp < FOREX_CACHE_TTL_MS && forexCache.rate > 0) {
    return forexCache.rate;
  }

  // 1. Primary Source: Frankfurter API (Official ECB rates, free, public, no key)
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR');
    if (res.ok) {
      const data = await res.json();
      if (data && data.rates && typeof data.rates.EUR === 'number') {
        const rate = parseFloat(data.rates.EUR);
        if (!isNaN(rate) && rate > 0) {
          forexCache = { rate, timestamp: now };
          saveForexToLocalStorage(forexCache);
          console.log(`[Forex - Frankfurter (ECB)] Loaded USD/EUR rate: ${rate} (cached for 5h)`);
          return rate;
        }
      }
    }
  } catch (err) {
    console.warn('[Forex - Frankfurter] Failed to fetch rate, trying Twelve Data backup:', err);
  }

  // 2. Backup Source: Twelve Data exchange_rate
  try {
    const key = getNextTwelveDataKey();
    const res = await fetch(
      `https://api.twelvedata.com/exchange_rate?symbol=USD/EUR&apikey=${key}`
    );
    if (res.ok) {
      const data = await res.json();
      if (data && data.rate) {
        const rate = parseFloat(data.rate);
        if (!isNaN(rate) && rate > 0) {
          forexCache = { rate, timestamp: now };
          saveForexToLocalStorage(forexCache);
          console.log(`[Forex - Twelve Data Backup] Loaded USD/EUR rate: ${rate}`);
          return rate;
        }
      }
    }
  } catch (err) {
    console.warn('[Forex - Twelve Data Backup] Failed to fetch rate:', err);
  }

  // 3. If live fetches failed, only use previous cache if still within 6-hour safety window
  if (forexCache && forexCache.rate > 0 && now - forexCache.timestamp < 6 * 60 * 60 * 1000) {
    return forexCache.rate;
  }

  console.error('[Forex Error] Both Frankfurter and Twelve Data failed, and no fresh cache exists.');
  return null;
}

/**
 * Get the currently cached USD to EUR rate, or null if none loaded.
 */
export function getCachedForexRate(): number | null {
  return forexCache && forexCache.rate > 0 ? forexCache.rate : null;
}

/**
 * Fetch current quote for a ticker.
 * SINGLE CONVERSION POINT: Any raw USD price fetched from Finnhub or Twelve Data
 * is converted to EUR IMMEDIATELY here.
 * The price returned and cached is ALWAYS in EUR. No downstream code should ever convert it again!
 */
export async function getQuoteForTicker(
  ticker: string,
  forceRefresh = false,
  explicitCurrency?: string
): Promise<{ price: number; rawUsdPrice?: number; monthChangePct?: number } | null> {
  const normalizedTicker = ticker.trim().toUpperCase();
  const now = Date.now();

  const cached = quotesCache.get(normalizedTicker);
  const monthChangePct = monthChangeCache.get(normalizedTicker)?.pct ?? cached?.monthChangePct;

  if (!forceRefresh && cached && now - cached.timestamp < QUOTE_CACHE_TTL_MS) {
    // cached.price is ALREADY in EUR from live quote fetch
    return { price: cached.price, monthChangePct };
  }

  const aliasConfig = TICKER_ALIASES[normalizedTicker];
  const symbolCandidates = aliasConfig
    ? [aliasConfig.primarySymbol, ...aliasConfig.fallbackSymbols]
    : [normalizedTicker];

  let rawPrice = 0;
  let resolvedCurrency = detectTickerCurrency(normalizedTicker, explicitCurrency);

  for (const symbol of symbolCandidates) {
    const symbolCurrency = detectTickerCurrency(symbol, explicitCurrency);

    // Try Finnhub first for fast quote
    try {
      const token = getNextFinnhubKey();
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`
      );
      const data = await res.json();
      if (data && typeof data.c === 'number' && data.c > 0) {
        rawPrice = data.c;
        resolvedCurrency = symbolCurrency;
        break;
      }
    } catch (err) {
      console.warn(`Finnhub quote failed for ${symbol}:`, err);
    }

    // Try Twelve Data price endpoint as fallback
    if (rawPrice <= 0) {
      try {
        const key = getNextTwelveDataKey();
        const res = await fetch(
          `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${key}`
        );
        const data = await res.json();
        if (data && data.price) {
          const parsed = parseFloat(data.price);
          if (!isNaN(parsed) && parsed > 0) {
            rawPrice = parsed;
            resolvedCurrency = symbolCurrency;
            break;
          }
        }
      } catch (err) {
        console.warn(`Twelve Data price failed for ${symbol}:`, err);
      }
    }
  }

  if (rawPrice > 0) {
    let finalEurPrice = rawPrice;
    let rawUsdPrice: number | undefined;

    // Plausibility check: If rawPrice > 5000 and not Berkshire Hathaway, it is in KRW/JPY
    if (rawPrice > 5000 && !normalizedTicker.includes('BRK') && resolvedCurrency !== 'KRW') {
      resolvedCurrency = 'KRW';
    }

    if (resolvedCurrency === 'EUR') {
      finalEurPrice = rawPrice;
    } else if (resolvedCurrency === 'USD') {
      // SINGLE CONVERSION POINT: Convert raw USD price to EUR immediately upon fetch!
      const rate = await getUsdToEurRate();
      if (!rate || rate <= 0) {
        console.warn(
          `[Currency Integrity] Cannot convert ${normalizedTicker} from USD: exchange rate unavailable.`
        );
        if (cached) {
          return {
            price: cached.price,
            monthChangePct: monthChangeCache.get(normalizedTicker)?.pct ?? cached?.monthChangePct,
          };
        }
        return null;
      }
      finalEurPrice = Math.round(rawPrice * rate * 1000) / 1000;
      rawUsdPrice = rawPrice;

      if (normalizedTicker.includes('ORCL') || normalizedTicker.endsWith('.US')) {
        console.log(`[Single Conversion Point - Live Quote Debug] ${normalizedTicker}`, {
          rawPriceUSDFromAPI: rawPrice,
          exchangeRateUsed_BCE: rate,
          convertedPriceEUR: finalEurPrice,
          pipelineStatus:
            'Converted exactly ONCE at raw fetch time; stored and used in EUR everywhere thereafter.',
        });
      }
    } else {
      // Convert other currencies (KRW, JPY, GBP, CHF) to EUR
      const rate = await getCurrencyToEurRate(resolvedCurrency);
      if (!rate || rate <= 0) {
        console.warn(
          `[Currency Integrity] Cannot convert ${normalizedTicker} from ${resolvedCurrency}: exchange rate unavailable.`
        );
        if (cached) {
          return {
            price: cached.price,
            monthChangePct: monthChangeCache.get(normalizedTicker)?.pct ?? cached?.monthChangePct,
          };
        }
        return null;
      }
      finalEurPrice = Math.round(rawPrice * rate * 1000) / 1000;

      const usdRate = await getUsdToEurRate();
      if (usdRate && usdRate > 0) {
        rawUsdPrice = Math.round((finalEurPrice / usdRate) * 100) / 100;
      }

      console.log(`[Multi-Currency Live Quote] ${normalizedTicker} (${resolvedCurrency})`, {
        rawPrice,
        rateToEUR: rate,
        finalEurPrice,
      });
    }

    const updated: QuoteCache = {
      price: finalEurPrice,
      monthChangePct,
      timestamp: now,
    };
    quotesCache.set(normalizedTicker, updated);
    saveQuotesToLocalStorage();
    return {
      price: finalEurPrice,
      rawUsdPrice: rawUsdPrice !== undefined ? rawUsdPrice : (resolvedCurrency === 'USD' ? rawPrice : undefined),
      monthChangePct,
    };
  }

  if (cached) {
    return {
      price: cached.price,
      monthChangePct: monthChangeCache.get(normalizedTicker)?.pct ?? cached?.monthChangePct,
    };
  }
  return null;
}

/**
 * Fetch historical prices for a ticker using Twelve Data's time series endpoint at 4-hour interval.
 * Logs exact parameters (symbol, interval, start_date, end_date, outputsize) and response count.
 */
export async function getHistoricalDailyPrices(
  ticker: string,
  startDate?: string,
  endDate?: string,
  outputsize = 5000,
  explicitCurrency?: string
): Promise<Array<{ date: string; close: number }>> {
  const normalizedTicker = ticker.trim().toUpperCase();
  const aliasConfig = TICKER_ALIASES[normalizedTicker];
  const symbolCandidates = aliasConfig
    ? [aliasConfig.primarySymbol, ...aliasConfig.fallbackSymbols]
    : [normalizedTicker];

  const key = getNextTwelveDataKey();

  for (const symbol of symbolCandidates) {
    const symbolCurrency = detectTickerCurrency(symbol, explicitCurrency);

    let url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
      symbol
    )}&interval=4h&outputsize=${outputsize}&apikey=${key}`;

    if (startDate) {
      url += `&start_date=${encodeURIComponent(startDate)}`;
    }
    if (endDate) {
      url += `&end_date=${encodeURIComponent(endDate)}`;
    }

    console.log(`[Twelve Data TimeSeries Request]`, {
      symbol,
      originalTicker: normalizedTicker,
      currency: symbolCurrency,
      interval: '4h',
      outputsize,
      start_date: startDate || 'ALL',
      end_date: endDate || 'NOW',
      keySuffix: key ? `...${key.slice(-4)}` : 'none',
    });

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (data && Array.isArray(data.values) && data.values.length > 0) {
        let toEurRate = 1;
        if (symbolCurrency !== 'EUR') {
          const rate = await getCurrencyToEurRate(symbolCurrency);
          if (rate && rate > 0) {
            toEurRate = rate;
          }
        }

        // SINGLE CONVERSION POINT: Converted immediately to EUR upon raw fetch
        const series: Array<{ date: string; close: number }> = data.values
          .map((item: { datetime: string; close: string }) => {
            const rawClose = parseFloat(item.close);
            const closeEur = symbolCurrency !== 'EUR' ? Math.round(rawClose * toEurRate * 1000) / 1000 : rawClose;
            return {
              date: item.datetime.replace('T', ' ').substring(0, 16),
              close: closeEur,
            };
          })
          .filter((item: { date: string; close: number }) => !isNaN(item.close) && item.close > 0)
          .sort((a: { date: string; close: number }, b: { date: string; close: number }) =>
            a.date.localeCompare(b.date)
          );

        console.log(
          `[Twelve Data TimeSeries Response] ${symbol} (for ${normalizedTicker}): received ${series.length} data points (converted to EUR).`
        );

        // Also compute 1-month change if we have at least 30 days of data
        if (series.length >= 2) {
          const latestPrice = series[series.length - 1].close;
          const targetDate = new Date();
          targetDate.setDate(targetDate.getDate() - 30);
          const targetIso = targetDate.toISOString().split('T')[0];

          let monthAgoPrice = series[0].close;
          for (let i = series.length - 1; i >= 0; i--) {
            if (series[i].date <= targetIso) {
              monthAgoPrice = series[i].close;
              break;
            }
          }
          if (monthAgoPrice > 0) {
            const monthChangePct = ((latestPrice - monthAgoPrice) / monthAgoPrice) * 100;

            // Store month change percentage ONLY in its dedicated cache (NEVER touch quotesCache)
            monthChangeCache.set(normalizedTicker, {
              pct: monthChangePct,
              timestamp: Date.now(),
            });
            saveMonthChangeToLocalStorage();
          }
        }

        return series;
      }
    } catch (err) {
      console.warn(`[Twelve Data TimeSeries Error] Failed for ${symbol}:`, err);
    }
  }

  return [];
}

/**
 * Smart ticker history fetcher with Firestore/LocalStorage persistence:
 * 1. Checks Firestore for existing cached historical series and lastCachedDate.
 * 2. If cached date is today (or market hasn't had a new close since), makes NO API call at all.
 * 3. If there are missing days since the last cached date, fetches ONLY that gap (last-cached-date to today),
 *    then appends the new points to the existing stored series.
 * 4. Never re-requests the entire historical range again once stored.
 */
export async function fetchTickerHistorySmart(
  ticker: string,
  userId?: string | null,
  requiredStartDate?: string
): Promise<Array<{ date: string; close: number }>> {
  const normalizedTicker = ticker.trim().toUpperCase();
  const todayIsoDate = new Date().toISOString().split('T')[0];

  let cached: CachedTickerHistory | null = null;
  if (userId) {
    cached = await loadTickerHistory(userId, normalizedTicker);
  }

  if (cached && cached.series && cached.series.length > 0) {
    const lastDate = cached.lastCachedDate || cached.series[cached.series.length - 1].date;
    const lastDay = lastDate.split(' ')[0];

    // Check if cache is already up to date (today or recent close within 8 hours)
    const lastTimeMs = new Date(lastDate.replace(' ', 'T')).getTime();
    const hoursSinceLast = (Date.now() - lastTimeMs) / (1000 * 60 * 60);

    if (lastDay >= todayIsoDate || hoursSinceLast < 8) {
      console.log(
        `[Historical Cache Hit] ${normalizedTicker}: series is up to date (last cached: ${lastDate}, ${cached.series.length} points). Making 0 API calls.`
      );
      return cached.series;
    }

    // Missing days detected: fetch ONLY the gap from lastDate to today!
    console.log(
      `[Historical Cache Gap Fetch] ${normalizedTicker}: Fetching only gap from ${lastDate} to today (cached points: ${cached.series.length}).`
    );

    const gapSeries = await getHistoricalDailyPrices(normalizedTicker, lastDay);
    if (gapSeries.length > 0) {
      // Merge and deduplicate by date
      const map = new Map<string, number>();
      cached.series.forEach((p) => map.set(p.date, p.close));
      gapSeries.forEach((p) => map.set(p.date, p.close));

      const merged = Array.from(map.entries())
        .map(([date, close]) => ({ date, close }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const newLastDate = merged[merged.length - 1].date;
      if (userId) {
        await saveTickerHistory(userId, normalizedTicker, merged, newLastDate);
      }
      console.log(
        `[Historical Cache Updated] ${normalizedTicker}: appended ${gapSeries.length} points, total series now ${merged.length} points.`
      );
      return merged;
    }

    return cached.series;
  }

  // Cache miss: initial full fetch
  console.log(
    `[Historical Cache Miss] ${normalizedTicker}: Initial full history fetch starting from ${requiredStartDate || 'origin'}.`
  );
  const fullSeries = await getHistoricalDailyPrices(normalizedTicker, requiredStartDate);
  if (fullSeries.length > 0 && userId) {
    const newestDate = fullSeries[fullSeries.length - 1].date;
    await saveTickerHistory(userId, normalizedTicker, fullSeries, newestDate);
  }
  return fullSeries;
}

/**
 * Small delay helper to avoid hitting 8 requests/min burst rate limits on free keys
 */
export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
