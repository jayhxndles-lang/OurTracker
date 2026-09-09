export interface Lot {
  positionId: string;
  ticker: string;
  name?: string;
  category: string; // STOCK, ETF, ETC, etc.
  volume: number;
  currentValue: number; // in EUR
  currentPrice: number;
  openPrice: number;
  openTime: string; // UTC ISO string
  netProfitEur: number;
  netProfitPct: number;
  currency: 'EUR' | 'USD' | 'GBP' | 'CHF' | string;
  investedCost?: number;
  monthChangePct?: number; // % change over the last month
  currentLivePrice?: number;
}

export interface Deposit {
  amount: number; // in EUR
  date: string; // YYYY-MM-DD
}

export interface NetWorthPoint {
  date: string; // YYYY-MM-DD
  value: number; // EUR
}

export interface PortfolioData {
  userId: string;
  updatedAt: string;
  moneyInvested: number;
  currentCapitalValue: number;
  positions: Lot[];
  deposits: Deposit[];
  netWorthHistory: NetWorthPoint[];
  lastQuotesUpdate?: string;
}

export interface ForexRateCache {
  rate: number;
  timestamp: number;
}

export interface QuoteCache {
  price: number;
  monthChangePct?: number;
  timestamp: number;
}
