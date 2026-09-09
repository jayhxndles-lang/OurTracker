import type { Lot, Deposit, NetWorthPoint } from './types';
import { getUsdToEurRate, getCurrencyToEurRate, detectTickerCurrency, fetchTickerHistorySmart, delay } from './api';

declare global {
  interface Window {
    XLSX: any;
  }
}

// Clean and parse numbers that might contain currency symbols, commas or spaces
export function parseNumeric(val: any): number {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  let str = String(val).trim();
  // Handle European number formats e.g. "1.234,56" vs "1,234.56"
  if (str.includes(',') && str.includes('.')) {
    if (str.indexOf('.') < str.indexOf(',')) {
      // European: dot is thousand separator, comma is decimal
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      // Standard US: comma is thousand separator
      str = str.replace(/,/g, '');
    }
  } else if (str.includes(',')) {
    // Only comma, likely decimal separator e.g. "12,50"
    str = str.replace(',', '.');
  } else if (str.includes('.')) {
    // Check if multiple dots e.g. "1.000.000"
    const parts = str.split('.');
    if (parts.length > 2) {
      str = str.replace(/\./g, '');
    }
  }
  str = str.replace(/[^0-9.-]+/g, '');
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

// Detect currency based on explicit column, symbol, or ticker suffix (.DE = EUR, etc.)
export function detectPositionCurrency(
  ticker: string,
  rawRowTexts = '',
  explicitCurrency = ''
): 'EUR' | 'USD' | 'GBP' | 'CHF' | 'KRW' | 'JPY' | string {
  return detectTickerCurrency(ticker, explicitCurrency || rawRowTexts);
}

// Check if a row represents a summary, total, or uninvested cash balance
function isSummaryOrCashRow(
  ticker: string,
  name: string,
  type: string,
  category: string
): boolean {
  const normTicker = normalizeKey(ticker);
  const normName = normalizeKey(name);
  const normType = normalizeKey(type);
  const normCat = normalizeKey(category);

  // Cash / Liquidez row
  if (
    normCat === 'cash' ||
    normCat === 'liquidez' ||
    normCat === 'moeda' ||
    normCat === 'currency' ||
    normTicker === 'cash' ||
    normTicker === 'liquidez' ||
    normTicker === 'eur' ||
    normTicker === 'usd' ||
    normName === 'cash' ||
    normName === 'liquidez' ||
    normName.startsWith('cash')
  ) {
    return true;
  }

  // Summary / Totals rows
  const summaryTokens = [
    'total',
    'summary',
    'sumario',
    'sum',
    'gesamt',
    'portfolio',
    'carteira',
    'overall',
    'subtotal',
    'totais',
    'soma',
    'all',
  ];

  for (const token of summaryTokens) {
    if (
      normType === token ||
      normType.includes(token) ||
      normTicker === token ||
      normName === token ||
      (normTicker.startsWith(token) && normTicker.length < 15) ||
      normName.startsWith('total') ||
      normName.startsWith('sumario') ||
      normName.startsWith('carteira') ||
      normName.startsWith('subtotal')
    ) {
      return true;
    }
  }

  // Long non-ticker strings that aren't 12-char ISINs
  if (ticker.length > 20 && !ticker.match(/^[A-Z0-9]{12}$/)) {
    return true;
  }

  return false;
}

// Normalize Date to YYYY-MM-DD
function parseIsoDate(val: any): string {
  if (!val) return new Date().toISOString().split('T')[0];
  if (typeof val === 'number') {
    // Excel serial date format
    const jsDate = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!isNaN(jsDate.getTime())) {
      return jsDate.toISOString().split('T')[0];
    }
  }
  const str = String(val).trim();
  // Try DD/MM/YYYY or DD-MM-YYYY format common in Europe
  const dmyMatch = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  const dateObj = new Date(val);
  if (!isNaN(dateObj.getTime())) {
    return dateObj.toISOString().split('T')[0];
  }
  return str.slice(0, 10);
}

// Read File as Uint8Array via FileReader for max iOS Safari compatibility
function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target?.result;
      if (buffer instanceof ArrayBuffer) {
        resolve(new Uint8Array(buffer));
      } else {
        reject(new Error('Could not read file buffer'));
      }
    };
    reader.onerror = () => reject(new Error('FileReader error during file upload'));
    reader.readAsArrayBuffer(file);
  });
}

export interface ParseResult {
  lots: Lot[];
  deposits: Deposit[];
  moneyInvested: number;
  currentCapitalValue: number;
  netWorthHistory: NetWorthPoint[];
}

// Clean string for header matching
function normalizeKey(str: string): string {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export async function parseGetquinFile(
  file: File,
  userId?: string | null,
  onProgress?: (msg: string, percent: number) => void
): Promise<ParseResult> {
  if (!window.XLSX) {
    throw new Error('SheetJS library is not loaded. Please verify your internet connection.');
  }

  onProgress?.('Reading Excel file...', 15);
  const data = await readFileAsUint8Array(file);

  let workbook: any;
  try {
    workbook = window.XLSX.read(data, { type: 'array', cellDates: true });
  } catch (err: any) {
    console.warn('Initial parse with cellDates failed, retrying raw:', err);
    try {
      workbook = window.XLSX.read(data, { type: 'array', cellDates: false });
    } catch (err2: any) {
      throw new Error(`Failed to decode Excel file: ${err2?.message || 'Invalid format'}`);
    }
  }

  onProgress?.('Accessing exchange rates...', 30);
  const usdToEurRate = await getUsdToEurRate();
  if (!usdToEurRate || usdToEurRate <= 0) {
    throw new Error(
      'Unable to obtain live USD/EUR exchange rate from financial market APIs. To maintain data integrity, currency conversion cannot proceed without a real market rate. Please verify network access and try again.'
    );
  }

  const sheetNames: string[] = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    throw new Error('The selected Excel file has no readable sheets.');
  }

  // Helper to find column index from header list
  const findColIndex = (headers: string[], ...candidateNames: string[]): number => {
    for (const cand of candidateNames) {
      const normCand = normalizeKey(cand);
      const idx = headers.findIndex((h) => {
        const normH = normalizeKey(h);
        return normH === normCand || normH.includes(normCand);
      });
      if (idx !== -1) return idx;
    }
    return -1;
  };

  interface DetectedSheetData {
    sheetName: string;
    headerRowIdx: number;
    headers: string[];
    dataRows: any[][];
  }

  // Scans a worksheet to locate the header row dynamically and read rows until an empty row
  const findSheetHeaderAndRows = (
    ws: any,
    sheetName: string,
    isHeaderRow: (firstCell: string, secondCell: string, row: any[]) => boolean
  ): DetectedSheetData | null => {
    if (!ws) return null;
    const rawGrid = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
    if (!rawGrid || rawGrid.length === 0) return null;

    let headerRowIdx = -1;
    for (let r = 0; r < Math.min(rawGrid.length, 60); r++) {
      const row = rawGrid[r];
      if (!row || row.length === 0) continue;
      const c0 = String(row[0] ?? '').trim();
      const c1 = String(row[1] ?? '').trim();
      if (isHeaderRow(c0, c1, row)) {
        headerRowIdx = r;
        break;
      }
    }

    if (headerRowIdx === -1) return null;

    const headers = rawGrid[headerRowIdx].map((c) => String(c ?? '').trim());
    const dataRows: any[][] = [];

    for (let r = headerRowIdx + 1; r < rawGrid.length; r++) {
      const row = rawGrid[r];
      if (!row || row.length === 0) break;
      const isAllEmpty = row.every((c) => String(c ?? '').trim() === '');
      if (isAllEmpty) break;
      dataRows.push(row);
    }

    return { sheetName, headerRowIdx, headers, dataRows };
  };

  // Helper to search across sheets with preferred names first, then all remaining sheets
  const scanForSheet = (
    preferredTokens: string[],
    predicate: (c0: string, c1: string, row: any[]) => boolean
  ): DetectedSheetData | null => {
    const preferred = sheetNames.filter((s) => {
      const norm = normalizeKey(s);
      return preferredTokens.some((tok) => norm.includes(normalizeKey(tok)));
    });
    const remaining = sheetNames.filter((s) => !preferred.includes(s));
    const searchOrder = [...preferred, ...remaining];

    for (const name of searchOrder) {
      const sheet = workbook.Sheets[name];
      const result = findSheetHeaderAndRows(sheet, name, predicate);
      if (result) return result;
    }
    return null;
  };

  // 1. Locate "Open Positions" sheet dynamically
  // Condition: header row starts with "Product" and has "Instrument/Position" as the second column
  let openPositionsData = scanForSheet(
    ['open', 'posic', 'position', 'bestand'],
    (c0, c1) => {
      const norm0 = c0.trim().toLowerCase();
      const norm1 = c1.trim().toLowerCase();
      const isProduct = norm0 === 'product' || norm0 === 'produto';
      const isInstPos =
        norm1.includes('instrument/position') ||
        norm1.includes('instrument') ||
        norm1.includes('posicao') ||
        norm1.includes('position');
      return isProduct && isInstPos;
    }
  );

  // Fallback if specific header signature wasn't found
  if (!openPositionsData) {
    openPositionsData = scanForSheet(
      ['open', 'posic', 'position', 'sheet1'],
      (_c0, _c1, row) => {
        const rowTexts = row.map((cell) => normalizeKey(String(cell)));
        const hasTicker = rowTexts.some((t) => t.includes('ticker') || t.includes('symbol') || t.includes('isin'));
        const hasVolOrVal = rowTexts.some((t) => t.includes('volume') || t.includes('shares') || t.includes('value'));
        return hasTicker && hasVolOrVal;
      }
    );
  }

  // 2. Locate "Cash Operations" sheet dynamically
  // Condition: header row starts with "Type" (columns: Type, Instrument, Ticker, Category, Time, Amount, ID, Comment, Product, Position ID)
  const cashSheetData = scanForSheet(
    ['cash', 'caixa', 'operation', 'operac', 'transac'],
    (c0, _c1, row) => {
      const norm0 = c0.trim().toLowerCase();
      if (norm0 !== 'type' && norm0 !== 'tipo') return false;
      return row.some((cell) => {
        const s = String(cell ?? '').trim().toLowerCase();
        return s === 'amount' || s === 'valor' || s === 'betrag' || s === 'instrument';
      });
    }
  );

  const lots: Lot[] = [];
  const deposits: Deposit[] = [];

  // Parse Open Positions
  if (openPositionsData) {
    onProgress?.(`Extracting positions from ${openPositionsData.sheetName}...`, 45);
    const headers = openPositionsData.headers;

    const productIdx = findColIndex(headers, 'Product', 'Produto');
    const instPosIdx = findColIndex(headers, 'Instrument/Position', 'Instrument', 'Position', 'Instrumento');
    const tickerIdx = findColIndex(headers, 'Ticker', 'Symbol', 'Simbolo', 'ISIN');
    const categoryIdx = findColIndex(headers, 'Category', 'Categoria', 'Asset Class');
    const typeIdx = findColIndex(headers, 'Type', 'Tipo');
    const volumeIdx = findColIndex(headers, 'Volume', 'Shares', 'Quantity', 'Quantidade', 'Units', 'Qtd');
    const valueIdx = findColIndex(headers, 'Value', 'Valor', 'Current Value', 'Market Value', 'Valor Atual');
    const currentPriceIdx = findColIndex(headers, 'Current price', 'Preço atual', 'Preco atual', 'Current Stock Price', 'Price', 'Kurs');
    const openPriceIdx = findColIndex(headers, 'Open price', 'Buy price', 'Preço de compra', 'Preco de compra', 'Preço médio', 'Open Price');
    const openTimeIdx = findColIndex(headers, 'Open time (UTC)', 'Open time', 'Data de abertura', 'Date', 'Time');
    const currencyIdx = findColIndex(headers, 'Currency', 'Moeda');
    const netProfitEurIdx = findColIndex(headers, 'Net profit (€)', 'Net profit EUR', 'Lucro líquido (€)', 'Lucro');
    const netProfitPctIdx = findColIndex(headers, 'Net profit (%)', 'Net profit %', 'Lucro líquido (%)');

    let currentInstrument: {
      name: string;
      ticker: string;
      category: string;
      product: string;
    } | null = null;

    for (let r = 0; r < openPositionsData.dataRows.length; r++) {
      const row = openPositionsData.dataRows[r];
      const rowType = String(typeIdx >= 0 ? row[typeIdx] ?? '' : '').trim();
      const instPosVal = String(instPosIdx >= 0 ? row[instPosIdx] ?? '' : '').trim();
      const tickerVal = String(tickerIdx >= 0 ? row[tickerIdx] ?? '' : '').trim().toUpperCase();
      const categoryVal = String(categoryIdx >= 0 ? row[categoryIdx] ?? '' : '').trim();
      const productVal = String(productIdx >= 0 ? row[productIdx] ?? '' : '').trim();

      // Summary row per instrument:
      // "has a value in 'Type's Category column but an empty 'Type' cell"
      if (!rowType || rowType.toUpperCase() !== 'BUY') {
        currentInstrument = {
          name: instPosVal || tickerVal || currentInstrument?.name || '',
          ticker: tickerVal || currentInstrument?.ticker || '',
          category: categoryVal || currentInstrument?.category || 'STOCK',
          product: productVal || currentInstrument?.product || '',
        };
        // Do not add summary rows as lots!
        continue;
      }

      // Lot row: rowType === 'BUY'
      // Identified by "Instrument/Position" column containing numeric Position ID
      // Only use lot rows with "Type" = "BUY" as individual positions
      const volume = parseNumeric(volumeIdx >= 0 ? row[volumeIdx] : 0);
      if (volume <= 0) continue;

      let currentVal = parseNumeric(valueIdx >= 0 ? row[valueIdx] : 0);
      let currPrice = parseNumeric(currentPriceIdx >= 0 ? row[currentPriceIdx] : 0);
      let openPrice = parseNumeric(openPriceIdx >= 0 ? row[openPriceIdx] : 0);
      const rawOpenTime = openTimeIdx >= 0 ? row[openTimeIdx] : '';
      const openIsoDate = parseIsoDate(rawOpenTime);

      const lotTicker = tickerVal || currentInstrument?.ticker || 'UNKNOWN';
      const lotName = currentInstrument?.name || lotTicker;
      const lotCategory = categoryVal || currentInstrument?.category || 'STOCK';
      const positionId = instPosVal || `${lotTicker}-${openIsoDate}-${volume}-${r}`;

      // Currency detection
      const currencyVal = String(currencyIdx >= 0 ? row[currencyIdx] ?? '' : '');
      const rawRowJoined = row.map((c: any) => String(c ?? '')).join(' ');
      const currency = detectPositionCurrency(lotTicker, rawRowJoined, currencyVal);

      // Raw Excel values for debugging/auditing
      const rawOpenPrice = openPrice;
      const rawCurrPrice = currPrice;
      const rawCurrentVal = currentVal;

      // Currency conversion: If position is non-EUR, convert openPrice, currPrice, and currentVal to EUR
      // BEFORE computing calculatedNetProfitEur, netProfitPct, and investedCost.
      if (currency !== 'EUR') {
        let rateToEur = 1;
        if (currency === 'USD') {
          rateToEur = usdToEurRate;
        } else {
          const fetchedRate = await getCurrencyToEurRate(currency);
          if (fetchedRate && fetchedRate > 0) rateToEur = fetchedRate;
        }

        if (rateToEur > 0 && rateToEur !== 1) {
          if (openPrice > 0) openPrice = openPrice * rateToEur;
          if (currPrice > 0) currPrice = currPrice * rateToEur;
          if (currentVal > 0) currentVal = currentVal * rateToEur;

          console.log(
            `[Foreign Currency Import Debug] Ticker: ${lotTicker} (${currency}) | Raw OpenPrice: ${rawOpenPrice} | Raw CurrPrice: ${rawCurrPrice} | Raw Value: ${rawCurrentVal} | Rate to EUR: ${rateToEur} => Final OpenPrice: €${openPrice.toFixed(4)} | Final CurrPrice: €${currPrice.toFixed(4)} | Final Value: €${currentVal.toFixed(2)}`
          );
        }
      }

      if (currentVal <= 0 && currPrice > 0) {
        currentVal = volume * currPrice;
      } else if (currentVal > 0 && currPrice <= 0) {
        currPrice = currentVal / volume;
      }

      if (openPrice <= 0 && currPrice > 0) {
        openPrice = currPrice;
      }

      const calculatedNetProfitEur = Math.round((currentVal - volume * openPrice) * 100) / 100;
      const netProfitEur =
        netProfitEurIdx >= 0 && row[netProfitEurIdx] !== ''
          ? Math.round(parseNumeric(row[netProfitEurIdx]) * 100) / 100
          : calculatedNetProfitEur;

      const netProfitPct =
        openPrice > 0
          ? Math.round(((currPrice - openPrice) / openPrice) * 10000) / 100
          : netProfitPctIdx >= 0 && row[netProfitPctIdx] !== ''
          ? parseNumeric(row[netProfitPctIdx])
          : 0;

      lots.push({
        positionId,
        ticker: lotTicker,
        name: lotName,
        category: lotCategory,
        volume,
        currentValue: Math.round(currentVal * 100) / 100,
        currentPrice: Math.round(currPrice * 1000) / 1000,
        openPrice: Math.round(openPrice * 1000) / 1000,
        investedCost: Math.round(volume * openPrice * 100) / 100,
        openTime: openIsoDate,
        netProfitEur,
        netProfitPct,
        currency,
      });
    }
  }

  // Parse Cash Operations Sheet (Money Invested = ONLY cash deposits)
  onProgress?.('Extracting cash deposits...', 65);
  let moneyInvested = 0;

  if (cashSheetData) {
    const headers = cashSheetData.headers;
    const typeIdx = findColIndex(headers, 'Type', 'Tipo');
    const amountIdx = findColIndex(headers, 'Amount', 'Valor', 'Total', 'Betrag', 'Montante');
    const timeIdx = findColIndex(headers, 'Time', 'Date', 'Data', 'Datum');

    for (const row of cashSheetData.dataRows) {
      const rawType = String(typeIdx >= 0 ? row[typeIdx] ?? '' : '').trim();

      // Case-sensitive exact match: Type === "Deposit"
      // Strictly do NOT include rows of type "Stock purchase", "Stock sell", or "Total"
      if (rawType === 'Deposit') {
        const rawAmt = parseNumeric(amountIdx >= 0 ? row[amountIdx] : 0);
        const amt = Math.abs(rawAmt);
        if (amt > 0) {
          moneyInvested += amt;
          const rawDate = timeIdx >= 0 ? row[timeIdx] : '';
          deposits.push({
            amount: Math.round(amt * 100) / 100,
            date: parseIsoDate(rawDate),
          });
        }
      }
    }
  }

  // Fallback if no Cash Operations sheet found or moneyInvested is 0:
  // Use purchase cost of open positions as initial money invested baseline
  if (moneyInvested === 0 && lots.length > 0) {
    moneyInvested = lots.reduce(
      (acc, lot) => acc + (lot.investedCost || lot.volume * lot.openPrice),
      0
    );
    lots.forEach((lot) => {
      deposits.push({
        amount: Math.round((lot.investedCost || lot.volume * lot.openPrice) * 100) / 100,
        date: lot.openTime,
      });
    });
  }

  // Total current capital value (sum of current values of open positions)
  const currentCapitalValue = lots.reduce((acc, lot) => acc + lot.currentValue, 0);

  // Reconstruct daily net worth history with progress
  onProgress?.('Fetching market prices & history...', 75);
  const netWorthHistory = await reconstructHistory(
    lots,
    deposits,
    usdToEurRate,
    userId,
    (subMsg, pct) => {
      onProgress?.(subMsg, pct);
    }
  );

  onProgress?.('Complete!', 100);

  return {
    lots,
    deposits,
    moneyInvested: Math.round(moneyInvested * 100) / 100,
    currentCapitalValue: Math.round(currentCapitalValue * 100) / 100,
    netWorthHistory,
  };
}

export async function reconstructHistory(
  lots: Lot[],
  deposits: Deposit[],
  usdToEurRate: number,
  userId?: string | null,
  onProgress?: (msg: string, percent: number) => void
): Promise<NetWorthPoint[]> {
  if (lots.length === 0) return [];

  // Determine earliest transaction date
  const allDates: string[] = [];
  lots.forEach((l) => allDates.push(l.openTime));
  deposits.forEach((d) => allDates.push(d.date));
  allDates.sort();

  const startDateStr = allDates[0] || new Date().toISOString().split('T')[0];
  const endDateStr = new Date().toISOString().split('T')[0];

  const uniqueTickers = Array.from(new Set(lots.map((l) => l.ticker.trim().toUpperCase())));
  const tickerHistoryMap: Map<string, Array<{ time: number; close: number }>> = new Map();

  for (let i = 0; i < uniqueTickers.length; i++) {
    const ticker = uniqueTickers[i];
    const pct = Math.round(75 + ((i + 1) / Math.max(1, uniqueTickers.length)) * 15);
    onProgress?.(`Checking history cache for ${ticker} (${i + 1}/${uniqueTickers.length})...`, pct);

    try {
      // Smart fetch: checks Firestore for cached date; if up-to-date, makes 0 calls; if gap, fetches only gap
      const history = await fetchTickerHistorySmart(ticker, userId, startDateStr);
      if (history && history.length > 0) {
        const sorted = history
          .map((pt) => ({
            time: new Date(pt.date.replace(' ', 'T')).getTime(),
            close: pt.close,
          }))
          .filter((pt) => !isNaN(pt.time) && pt.close > 0)
          .sort((a, b) => a.time - b.time);

        tickerHistoryMap.set(ticker, sorted);
      }
    } catch (e) {
      console.warn(`Could not load history for ${ticker}:`, e);
    }

    if (i < uniqueTickers.length - 1) {
      await delay(150);
    }
  }

  onProgress?.('Synthesizing 4-hour timeline...', 94);

  // Build 4-hour timeline from startDate up to current moment
  const points: NetWorthPoint[] = [];
  const start = new Date(startDateStr);
  const end = new Date(); // Up to current moment to ensure today's intervals are fully plotted

  const stepMs = 4 * 60 * 60 * 1000;
  const curr = new Date(start);
  curr.setMinutes(0, 0, 0);
  curr.setHours(Math.floor(curr.getHours() / 4) * 4);

  while (curr.getTime() <= end.getTime()) {
    const timeIso = curr.toISOString();
    const pointDateStr = timeIso.replace('T', ' ').substring(0, 16);
    const dayPrefix = timeIso.split('T')[0];
    const currTime = curr.getTime();

    const activeLots = lots.filter((l) => l.openTime <= dayPrefix || l.openTime <= pointDateStr);

    let pointValue = 0;
    for (const lot of activeLots) {
      const historyList = tickerHistoryMap.get(lot.ticker);
      let lotPrice = 0;

      if (historyList && historyList.length > 0) {
        // Find most recent price at or before currTime
        for (let idx = historyList.length - 1; idx >= 0; idx--) {
          if (historyList[idx].time <= currTime) {
            lotPrice = historyList[idx].close;
            break;
          }
        }
        if (lotPrice <= 0 && currTime < historyList[0].time) {
          lotPrice = historyList[0].close;
        }
      }

      if (lotPrice <= 0) {
        const lotOpenTime = new Date(lot.openTime).getTime();
        const lotDuration = Math.max(1, end.getTime() - lotOpenTime);
        const elapsed = Math.max(0, currTime - lotOpenTime);
        const progress = Math.min(1, elapsed / lotDuration);
        lotPrice = lot.openPrice + (lot.currentPrice - lot.openPrice) * progress;
      }

      pointValue += lot.volume * lotPrice;
    }

    points.push({
      date: pointDateStr,
      value: Math.round(pointValue * 100) / 100,
    });

    curr.setTime(curr.getTime() + stepMs);
  }

  if (points.length > 0) {
    const totalCurrent = lots.reduce((acc, l) => acc + l.currentValue, 0);
    points[points.length - 1].value = Math.round(totalCurrent * 100) / 100;
  }

  console.log(
    `[Reconstruct History Complete] Synthesized ${points.length} 4-hour data points across portfolio history from ${startDateStr} to ${end.toISOString().replace('T', ' ').substring(0, 16)}.`
  );

  return points;
}
