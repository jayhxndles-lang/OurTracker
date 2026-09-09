import './index.css';
import type { PortfolioData, Lot, Deposit, NetWorthPoint } from './types';
import { initAuth, testConnection, savePortfolio, loadPortfolio } from './firebase';
import { getQuoteForTicker, getUsdToEurRate, fetchTickerHistorySmart, getCachedForexRate, isTickerUsd } from './api';
import { parseGetquinFile, detectPositionCurrency } from './excel';
import { NetWorthChart, type ChartPeriod } from './chart';

// Application State
let currentUser: any = null;
let currentPortfolio: PortfolioData | null = null;
let chartInstance: NetWorthChart | null = null;
let lastUpdateTimestamp: number = Date.now();
let updateTimerInterval: any = null;
let activeChartPeriod: ChartPeriod = '1M';
let deferredInstallPrompt: any = null;

const appContainer = document.getElementById('app')!;

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

// Track install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  renderInstallBtnIfNeeded();
});

// Format Currency in EUR
function formatEur(amount: number): string {
  return `€${amount.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Format Currency in USD
function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Helper to render price badge showing both EUR and USD when applicable
function renderStockPriceBadge(lot: Lot): string {
  const usdRate = getCachedForexRate() || 0.8581;
  const isUsd = lot.currency === 'USD' || isTickerUsd(lot.ticker, lot.currency);
  const usdPrice = isUsd && usdRate > 0 ? lot.currentPrice / usdRate : null;

  return `
    <span class="inline-flex items-center gap-1 text-[10px] font-bold text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded" title="Preço atual por ação">
      <span>${formatEur(lot.currentPrice)}</span>
      ${usdPrice ? `<span class="text-slate-500 font-medium ml-0.5">(${formatUsd(usdPrice)})</span>` : ''}
    </span>
  `;
}

// Format relative time: "Last updated X min ago"
function getRelativeTimeStr(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return '1 hour ago';
  return `${hours} hours ago`;
}

// Render Splash / Loading Screen
function showSplashScreen() {
  appContainer.innerHTML = `
    <div id="splash-screen" class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white">
      <div class="flex flex-col items-center">
        <h1 class="text-4xl font-bold tracking-tight text-slate-900 select-none animate-pulse-subtle">
          Johnfolio
        </h1>
        <p class="text-xs tracking-widest text-slate-400 mt-2 font-medium uppercase">
          Portfolio Tracker
        </p>
      </div>
    </div>
  `;
}

// Render Offline / Error State (do not show stale cached data when offline)
function showOfflineScreen() {
  appContainer.innerHTML = `
    <div class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white px-6 text-center">
      <div class="w-16 h-16 rounded-full bg-rose-50 flex items-center justify-center text-rose-500 mb-5">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 4.243a9 9 0 01-12.728 0m0 0l2.829-2.829m-2.829 2.829L3 21m2.829-15.536a9 9 0 0112.728 0m-8.486 4.243a5 5 0 017.072 0" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-slate-900 tracking-tight">No Internet Connection</h2>
      <p class="mt-2 text-sm text-slate-500 max-w-xs leading-relaxed">
        Johnfolio requires an active network connection to authenticate securely and fetch portfolio data.
      </p>
      <button id="retry-connect-btn" class="mt-6 px-6 py-3 rounded-xl bg-blue-600 text-white font-semibold text-sm shadow-md active:scale-95 transition-transform">
        Retry Connection
      </button>
    </div>
  `;

  document.getElementById('retry-connect-btn')?.addEventListener('click', () => {
    if (navigator.onLine) {
      initializeApp();
    } else {
      const btn = document.getElementById('retry-connect-btn');
      if (btn) {
        btn.textContent = 'Still Offline...';
        setTimeout(() => {
          btn.textContent = 'Retry Connection';
        }, 1500);
      }
    }
  });
}

// Compute Top 5 Best Performers and Top 4 Worst Performers
function computeRankedPerformers(lots: Lot[]): { top5Best: Lot[]; top4Worst: Lot[] } {
  // Group by ticker to get instrument-level performance over the last month
  const tickerMap: Map<string, Lot> = new Map();
  for (const lot of lots) {
    const existing = tickerMap.get(lot.ticker);
    if (!existing) {
      tickerMap.set(lot.ticker, { ...lot });
    } else {
      // Sum volumes and weighted returns
      existing.volume += lot.volume;
      existing.currentValue += lot.currentValue;
    }
  }

  const items = Array.from(tickerMap.values());

  // Assign monthChangePct: fallback to netProfitPct or current vs open if not set
  items.forEach((item) => {
    if (item.monthChangePct === undefined) {
      item.monthChangePct = item.netProfitPct || 0;
    }
  });

  // Sort descending for best performers
  const sortedDesc = [...items].sort((a, b) => (b.monthChangePct || 0) - (a.monthChangePct || 0));

  // Sort ascending for worst performers
  const sortedAsc = [...items].sort((a, b) => (a.monthChangePct || 0) - (b.monthChangePct || 0));

  const top5Best = sortedDesc.slice(0, 5);
  const top4Worst = sortedAsc.slice(0, 4);

  return { top5Best, top4Worst };
}

// Main App Shell Rendering
function renderDashboard() {
  const hasData = currentPortfolio && currentPortfolio.positions.length > 0;
  const moneyInvested = currentPortfolio?.moneyInvested || 0;
  const currentCapital = currentPortfolio?.currentCapitalValue || 0;
  const diffVal = currentCapital - moneyInvested;
  const diffPct = moneyInvested > 0 ? (diffVal / moneyInvested) * 100 : 0;
  const isPositive = diffVal >= 0;

  const { top5Best, top4Worst } = hasData
    ? computeRankedPerformers(currentPortfolio!.positions)
    : { top5Best: [], top4Worst: [] };

  const isIOS = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());

  appContainer.innerHTML = `
    <!-- Top Header (iOS Navigation Bar) -->
    <header class="ios-glass sticky top-0 z-30 pt-safe border-b border-slate-200/80 px-4 pb-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="text-xl font-bold tracking-tight text-slate-950">Johnfolio</span>
        <div id="status-pill" class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-100 text-[11px] font-medium text-slate-500">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          <span id="status-text">${getRelativeTimeStr(lastUpdateTimestamp)}</span>
        </div>
      </div>
      
      <div class="flex items-center gap-2">
        <button id="pwa-install-btn" class="hidden text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-700 active:bg-slate-100">
          Install
        </button>

        ${
          hasData
            ? `
        <!-- Edit Portfolio Button -->
        <button id="edit-portfolio-btn" class="btn-touch flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-slate-200/90 bg-white text-slate-700 text-xs font-semibold shadow-xs active:scale-95 transition-transform">
          <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span>Editar</span>
        </button>
        `
            : ''
        }

        <!-- Upload Getquin XLSX Button -->
        <label for="excel-upload-input" class="btn-touch flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-semibold shadow-sm cursor-pointer active:scale-95 transition-transform">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <span>Upload</span>
        </label>
        <input type="file" id="excel-upload-input" accept=".xlsx,.xls" class="hidden" />
      </div>
    </header>

    <!-- Scrollable Content with Pull-To-Refresh -->
    <main id="main-scroll-view" class="flex-1 smooth-touch-scroll pb-24 relative">
      <!-- Pull to refresh spinner indicator -->
      <div id="pull-refresh-indicator" class="pull-indicator absolute top-0 left-0 right-0 h-12 flex items-center justify-center pointer-events-none opacity-0 -translate-y-6">
        <div class="flex items-center gap-2 px-3 py-1 rounded-full bg-white/90 border border-slate-200 text-slate-600 text-xs font-medium shadow-sm">
          <svg id="pull-spinner" class="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span id="pull-label">Pull to refresh</span>
        </div>
      </div>

      <div class="p-4 space-y-4 max-w-md mx-auto">
        ${
          !hasData
            ? `
          <!-- Empty State -->
          <div class="ios-card p-6 text-center mt-4">
            <div class="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-3">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h2 class="text-lg font-bold text-slate-900 tracking-tight">No Portfolio Uploaded</h2>
            <p class="text-xs text-slate-500 mt-1 leading-relaxed">
              Export your portfolio as a <span class="font-semibold text-slate-700">.xlsx</span> file from the <span class="font-semibold text-slate-700">Getquin</span> app, then tap the <span class="font-semibold text-blue-600">Upload</span> button above.
            </p>
            <div class="mt-4 pt-4 border-t border-slate-100 flex flex-col gap-2">
              <label for="excel-upload-input" class="w-full py-2.5 rounded-xl bg-blue-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer active:scale-95 transition-transform">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Select Getquin .xlsx File
              </label>
              <button id="load-sample-btn" class="w-full py-2.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-semibold active:bg-slate-200 transition-colors">
                Load Sample Getquin Portfolio
              </button>
            </div>
          </div>
        `
            : `
          <!-- Primary Capital Value Card -->
          <div class="ios-card p-5">
            <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Current Capital Value
            </div>
            <div class="mt-1 text-3xl font-extrabold tracking-tight text-slate-950">
              ${formatEur(currentCapital)}
            </div>

            <div class="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
              <div>
                <span class="text-[11px] font-medium text-slate-400 block">Money Invested</span>
                <span class="text-sm font-bold text-slate-800">${formatEur(moneyInvested)}</span>
              </div>
              <div>
                <span class="text-[11px] font-medium text-slate-400 block">Difference</span>
                <span class="text-sm font-bold flex items-center gap-1 ${isPositive ? 'text-emerald-600' : 'text-rose-600'}">
                  ${isPositive ? '+' : ''}${formatEur(diffVal)}
                  <span class="text-[11px] font-semibold opacity-90">(${isPositive ? '+' : ''}${diffPct.toFixed(2)}%)</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Net Worth Chart Card -->
          <div class="ios-card p-4">
            <div class="flex items-center justify-between mb-2">
              <div class="flex flex-col">
                <span class="text-xs font-bold text-slate-800 tracking-tight">Net Worth History</span>
                <span id="chart-scrub-caption" class="text-[11px] text-slate-400 font-medium">Scrub or pinch-to-zoom to inspect</span>
              </div>
              <div class="flex items-center gap-2 text-[10px] text-slate-500">
                <div class="flex items-center gap-1">
                  <span class="w-3 h-0.5 bg-blue-600 inline-block rounded-full"></span>
                  <span>Net Worth</span>
                </div>
                <div class="flex items-center gap-1">
                  <span class="w-3 border-b border-dashed border-slate-400 inline-block"></span>
                  <span>Invested</span>
                </div>
                <div class="flex items-center gap-1">
                  <span class="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
                  <span>Deposit</span>
                </div>
              </div>
            </div>

            <!-- Canvas Container -->
            <div id="chart-canvas-container" class="w-full h-56 relative my-1"></div>

            <!-- Period Selector Bar -->
            <div class="flex items-center justify-between pt-2 border-t border-slate-100 px-1">
              <button data-period="1D" class="period-btn ${activeChartPeriod === '1D' ? 'active' : ''}">1D</button>
              <button data-period="1W" class="period-btn ${activeChartPeriod === '1W' ? 'active' : ''}">1W</button>
              <button data-period="1M" class="period-btn ${activeChartPeriod === '1M' ? 'active' : ''}">1M</button>
              <button data-period="3M" class="period-btn ${activeChartPeriod === '3M' ? 'active' : ''}">3M</button>
              <button data-period="1Y" class="period-btn ${activeChartPeriod === '1Y' ? 'active' : ''}">1Y</button>
              <button data-period="YTD" class="period-btn ${activeChartPeriod === 'YTD' ? 'active' : ''}">YTD</button>
              <button data-period="CUSTOM" class="period-btn ${activeChartPeriod === 'CUSTOM' ? 'active' : ''}">Custom</button>
            </div>
          </div>

          <!-- Top 5 Best Performers List -->
          <div class="ios-card p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">
                Top 5 Best Performers
              </h3>
              <span class="text-[11px] text-slate-400 font-medium">Last Month %</span>
            </div>

            <div class="divide-y divide-slate-100">
              ${
                top5Best.length === 0
                  ? '<div class="text-xs text-slate-400 py-2">No items available</div>'
                  : top5Best
                      .map(
                        (lot) => `
                <div class="py-2.5 flex items-center justify-between">
                  <div class="flex items-center gap-2.5">
                    <span class="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-xs shrink-0">
                      ${lot.ticker.slice(0, 2)}
                    </span>
                    <div>
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-xs font-bold text-slate-900">${lot.ticker}</span>
                        ${renderStockPriceBadge(lot)}
                      </div>
                      <div class="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
                        <span class="px-1 py-0.2 rounded bg-slate-100 text-slate-600 text-[9px] font-semibold">${lot.category}</span>
                        <span class="truncate max-w-[120px]">${lot.name || ''}</span>
                      </div>
                    </div>
                  </div>
                  <div class="text-right shrink-0">
                    <div class="text-xs font-bold text-emerald-600">
                      +${(lot.monthChangePct || 0).toFixed(2)}%
                    </div>
                    <div class="text-[10px] text-slate-400 font-medium">Total: ${formatEur(lot.currentValue)}</div>
                  </div>
                </div>
              `
                      )
                      .join('')
              }
            </div>
          </div>

          <!-- Top 4 Worst Performers List -->
          <div class="ios-card p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">
                Top 4 Worst Performers
              </h3>
              <span class="text-[11px] text-slate-400 font-medium">Last Month %</span>
            </div>

            <div class="divide-y divide-slate-100">
              ${
                top4Worst.length === 0
                  ? '<div class="text-xs text-slate-400 py-2">No items available</div>'
                  : top4Worst
                      .map(
                        (lot) => `
                <div class="py-2.5 flex items-center justify-between">
                  <div class="flex items-center gap-2.5">
                    <span class="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center font-bold text-xs shrink-0">
                      ${lot.ticker.slice(0, 2)}
                    </span>
                    <div>
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-xs font-bold text-slate-900">${lot.ticker}</span>
                        ${renderStockPriceBadge(lot)}
                      </div>
                      <div class="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
                        <span class="px-1 py-0.2 rounded bg-slate-100 text-slate-600 text-[9px] font-semibold">${lot.category}</span>
                        <span class="truncate max-w-[120px]">${lot.name || ''}</span>
                      </div>
                    </div>
                  </div>
                  <div class="text-right shrink-0">
                    <div class="text-xs font-bold ${(lot.monthChangePct || 0) < 0 ? 'text-rose-600' : 'text-slate-700'}">
                      ${(lot.monthChangePct || 0) >= 0 ? '+' : ''}${(lot.monthChangePct || 0).toFixed(2)}%
                    </div>
                    <div class="text-[10px] text-slate-400 font-medium">Total: ${formatEur(lot.currentValue)}</div>
                  </div>
                </div>
              `
                      )
                      .join('')
              }
            </div>
          </div>
        `
        }
      </div>
    </main>

    <!-- Bottom Tab Bar (iOS Style) -->
    <nav class="ios-glass fixed bottom-0 left-0 right-0 pb-safe border-t border-slate-200/80 z-30">
      <div class="max-w-md mx-auto flex items-center justify-center h-14">
        <button class="flex flex-col items-center justify-center text-blue-600 w-24">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
          </svg>
          <span class="text-[10px] font-semibold tracking-tight mt-0.5">Dashboard</span>
        </button>
      </div>
    </nav>

    <!-- Custom Date Range Modal -->
    <div id="custom-range-modal" class="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-end sm:items-center justify-center hidden">
      <div class="bg-white rounded-t-2xl sm:rounded-2xl p-5 w-full max-w-sm pb-safe shadow-2xl">
        <div class="flex items-center justify-between pb-3 border-b border-slate-100">
          <h3 class="text-sm font-bold text-slate-900">Custom Date Range</h3>
          <button id="close-modal-btn" class="text-slate-400 hover:text-slate-600 text-sm font-medium">Cancel</button>
        </div>
        <div class="mt-4 space-y-3">
          <div>
            <label class="text-xs font-semibold text-slate-600 block mb-1">Start Date</label>
            <input type="date" id="custom-start-input" class="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl bg-slate-50 font-medium" />
          </div>
          <div>
            <label class="text-xs font-semibold text-slate-600 block mb-1">End Date</label>
            <input type="date" id="custom-end-input" class="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl bg-slate-50 font-medium" />
          </div>
        </div>
        <button id="apply-custom-range-btn" class="w-full mt-5 py-2.5 rounded-xl bg-blue-600 text-white text-xs font-bold shadow active:scale-95 transition-transform">
          Apply Range
        </button>
      </div>
    </div>

    <!-- Error Feedback Modal -->
    <div id="error-modal" class="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 hidden">
      <div class="bg-white rounded-2xl p-5 w-full max-w-sm text-center shadow-2xl">
        <div class="w-12 h-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-3">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 id="error-modal-title" class="text-base font-bold text-slate-900">Upload Issue</h3>
        <p id="error-modal-desc" class="text-xs text-slate-500 mt-2 leading-relaxed text-left max-h-48 overflow-y-auto">
        </p>
        <button id="close-error-modal-btn" class="w-full mt-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-semibold active:scale-95 transition-transform">
          Dismiss
        </button>
      </div>
    </div>

    <!-- Minimalist iOS Processing Progress Modal -->
    <div id="processing-modal" class="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-md flex items-center justify-center p-6 hidden">
      <div class="bg-white rounded-3xl p-6 w-full max-w-xs text-center shadow-2xl border border-slate-100">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Carregando</span>
          <span id="processing-percent-text" class="text-xs font-extrabold text-blue-600 font-mono">0%</span>
        </div>
        <!-- Progress bar track -->
        <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden mb-3 relative">
          <div id="processing-progress-bar" class="bg-blue-600 h-full rounded-full transition-all duration-200 ease-out" style="width: 0%"></div>
        </div>
        <p id="processing-status-text" class="text-xs font-medium text-slate-600 leading-relaxed truncate">
          Lendo ficheiro...
        </p>
      </div>
    </div>

    <!-- Review & Edit Drawer (iOS Bottom Sheet) -->
    <div id="review-modal" class="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end justify-center hidden">
      <div class="bg-white rounded-t-3xl w-full max-w-lg max-h-[88vh] flex flex-col shadow-2xl pb-safe">
        <!-- Grabber bar -->
        <div class="w-10 h-1 bg-slate-200 rounded-full mx-auto mt-3 mb-1"></div>
        
        <!-- Header -->
        <div class="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 class="text-base font-bold text-slate-900">Revisar Carteira</h3>
            <p id="review-lots-count" class="text-xs text-slate-500">0 lotes identificados</p>
          </div>
          <button type="button" id="close-review-modal-btn" class="text-xs font-bold text-slate-400 hover:text-slate-700 py-1.5 px-3 rounded-lg hover:bg-slate-100 active:scale-95 transition-transform">
            Descartar
          </button>
        </div>

        <!-- Scrollable Content -->
        <div class="flex-1 overflow-y-auto p-4 space-y-4 -webkit-overflow-scrolling-touch">
          <!-- Money Invested Card (Independent: purely cash deposits) -->
          <div class="bg-slate-50 border border-slate-200/80 rounded-2xl p-4">
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-bold text-slate-800">Money Invested (€)</label>
              <span class="text-[10px] font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">Aportes em Caixa</span>
            </div>
            <p class="text-[11px] text-slate-500 mb-2 leading-tight">
              Total de dinheiro transferido para a corretora (não é somado às ações).
            </p>
            <div class="relative">
              <span class="absolute left-3 top-2 text-slate-400 text-sm font-semibold">€</span>
              <input type="number" step="any" id="review-money-invested" class="w-full pl-8 pr-3 py-2 text-sm font-bold text-slate-900 bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" />
            </div>
          </div>

          <!-- Lots Header & Add Button -->
          <div class="flex items-center justify-between px-1">
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">Ações & Posições</h4>
            <button type="button" id="add-lot-btn" class="text-xs text-blue-600 font-bold flex items-center gap-1 hover:text-blue-700 active:scale-95 py-1 px-2.5 rounded-lg bg-blue-50">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4"/></svg>
              Adicionar Lote
            </button>
          </div>

          <!-- Lots List Container -->
          <div id="review-lots-list" class="space-y-3">
            <!-- Dynamic Lot Cards -->
          </div>
        </div>

        <!-- Sticky Footer Action -->
        <div class="p-4 border-t border-slate-100 bg-white flex gap-3">
          <button type="button" id="cancel-review-btn" class="flex-1 py-3 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold active:scale-95 transition-transform">
            Cancelar
          </button>
          <button type="button" id="confirm-save-review-btn" class="flex-2 py-3 rounded-xl bg-blue-600 text-white text-xs font-bold shadow-md shadow-blue-500/25 active:scale-95 transition-transform">
            Confirmar e Salvar
          </button>
        </div>
      </div>
    </div>

    <!-- iOS PWA Install Instructions Modal -->
    <div id="ios-install-modal" class="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-end justify-center p-4 pb-safe hidden">
      <div class="bg-white rounded-2xl p-5 w-full max-w-sm text-center shadow-2xl">
        <h3 class="text-base font-bold text-slate-900">Add Johnfolio to Home Screen</h3>
        <p class="text-xs text-slate-500 mt-2 leading-relaxed text-left">
          1. Tap the <strong class="text-slate-800">Share</strong> icon (<svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>) in Safari's bottom toolbar.<br/>
          2. Scroll down and choose <strong class="text-slate-800">Add to Home Screen</strong>.
        </p>
        <button id="close-ios-guide-btn" class="w-full mt-4 py-2.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-semibold">
          Got it
        </button>
      </div>
    </div>
  `;

  // Attach interactive listeners
  setupDashboardListeners();

  // Initialize Canvas Chart if data is present
  if (hasData) {
    initCanvasChart();
  }

  // Setup Pull-to-Refresh
  setupPullToRefresh();

  // Check install button
  renderInstallBtnIfNeeded();
}

function renderInstallBtnIfNeeded() {
  const btn = document.getElementById('pwa-install-btn');
  if (!btn) return;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true;

  if (isStandalone) {
    btn.classList.add('hidden');
    return;
  }

  const isIOS = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
  if (deferredInstallPrompt || isIOS) {
    btn.classList.remove('hidden');
  }
}

function setupDashboardListeners() {
  // File Upload
  const fileInput = document.getElementById('excel-upload-input') as HTMLInputElement;
  fileInput?.addEventListener('change', async (e: any) => {
    const file = e.target?.files?.[0];
    if (file) {
      await handleExcelUpload(file);
    }
  });

  // Load Sample Button
  document.getElementById('load-sample-btn')?.addEventListener('click', async () => {
    await loadSampleData();
  });

  // Period Buttons
  const periodBtns = document.querySelectorAll('.period-btn');
  periodBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-period') as ChartPeriod;
      if (p === 'CUSTOM') {
        openCustomRangeModal();
      } else {
        activeChartPeriod = p;
        periodBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        chartInstance?.setPeriod(p);
      }
    });
  });

  // Custom Modal
  document.getElementById('close-modal-btn')?.addEventListener('click', () => {
    document.getElementById('custom-range-modal')?.classList.add('hidden');
  });

  document.getElementById('apply-custom-range-btn')?.addEventListener('click', () => {
    const start = (document.getElementById('custom-start-input') as HTMLInputElement).value;
    const end = (document.getElementById('custom-end-input') as HTMLInputElement).value;
    if (start && end) {
      activeChartPeriod = 'CUSTOM';
      document.querySelectorAll('.period-btn').forEach((b) => {
        if (b.getAttribute('data-period') === 'CUSTOM') b.classList.add('active');
        else b.classList.remove('active');
      });
      chartInstance?.setPeriod('CUSTOM', start, end);
      document.getElementById('custom-range-modal')?.classList.add('hidden');
    }
  });

  // PWA Install
  document.getElementById('pwa-install-btn')?.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        deferredInstallPrompt = null;
        renderInstallBtnIfNeeded();
      }
    } else {
      // iOS Guide
      document.getElementById('ios-install-modal')?.classList.remove('hidden');
    }
  });

  document.getElementById('close-ios-guide-btn')?.addEventListener('click', () => {
    document.getElementById('ios-install-modal')?.classList.add('hidden');
  });

  // Error modal dismiss
  document.getElementById('close-error-modal-btn')?.addEventListener('click', () => {
    document.getElementById('error-modal')?.classList.add('hidden');
  });

  // Edit Portfolio Button (Header)
  document.getElementById('edit-portfolio-btn')?.addEventListener('click', () => {
    if (currentPortfolio) {
      openReviewModal(currentPortfolio);
    }
  });

  // Review Modal Discard/Cancel
  document.getElementById('close-review-modal-btn')?.addEventListener('click', () => {
    document.getElementById('review-modal')?.classList.add('hidden');
  });

  document.getElementById('cancel-review-btn')?.addEventListener('click', () => {
    document.getElementById('review-modal')?.classList.add('hidden');
  });

  // Add Lot Button in Review Modal
  document.getElementById('add-lot-btn')?.addEventListener('click', () => {
    addNewLotToReview();
  });

  // Confirm and Save Review Portfolio
  document.getElementById('confirm-save-review-btn')?.addEventListener('click', async () => {
    await saveConfirmedReviewPortfolio();
  });
}

function showError(title: string, message: string) {
  const modal = document.getElementById('error-modal');
  const titleEl = document.getElementById('error-modal-title');
  const descEl = document.getElementById('error-modal-desc');
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = message;
  modal?.classList.remove('hidden');
}

function openCustomRangeModal() {
  const modal = document.getElementById('custom-range-modal');
  if (!modal) return;
  const startInput = document.getElementById('custom-start-input') as HTMLInputElement;
  const endInput = document.getElementById('custom-end-input') as HTMLInputElement;

  if (currentPortfolio && currentPortfolio.netWorthHistory.length > 0) {
    const pts = currentPortfolio.netWorthHistory;
    startInput.value = pts[0].date;
    endInput.value = pts[pts.length - 1].date;
  } else {
    const today = new Date().toISOString().split('T')[0];
    startInput.value = today;
    endInput.value = today;
  }
  modal.classList.remove('hidden');
}

function initCanvasChart() {
  const container = document.getElementById('chart-canvas-container');
  if (!container || !currentPortfolio) return;

  if (chartInstance) {
    chartInstance.destroy();
  }

  const captionEl = document.getElementById('chart-scrub-caption');

  chartInstance = new NetWorthChart({
    container,
    points: currentPortfolio.netWorthHistory,
    deposits: currentPortfolio.deposits,
    accentColor: '#0066FF',
    onTooltipChange: (data) => {
      if (!captionEl) return;
      if (!data) {
        captionEl.textContent = 'Scrub or pinch-to-zoom to inspect';
        captionEl.className = 'text-[11px] text-slate-400 font-medium';
      } else if (data.groupedDeposit) {
        const dep = data.groupedDeposit;
        if (dep.items.length > 1) {
          const itemsList = dep.items
            .map((item) => {
              const dt = new Date(item.date).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              });
              return `+€${item.amount.toLocaleString('de-DE')} (${dt})`;
            })
            .join(' • ');
          captionEl.innerHTML = `<span class="text-emerald-600 font-semibold">+€${dep.totalAmount.toLocaleString('de-DE')} Week Total</span> <span class="text-slate-500 font-normal">(${dep.items.length} deposits: ${itemsList})</span>`;
        } else {
          captionEl.innerHTML = `<span class="text-emerald-600 font-semibold">+€${dep.totalAmount.toLocaleString('de-DE')} Deposit</span> on ${data.date} • <span class="text-slate-600">Net: €${data.value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
        }
      } else {
        captionEl.innerHTML = `<strong class="text-slate-800">€${data.value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> Net • <span class="text-slate-500 font-medium">€${data.investedValue.toLocaleString('de-DE')} Invested</span> • <span class="text-slate-400">${data.date}</span>`;
      }
    },
  });

  chartInstance.setPeriod(activeChartPeriod);
}

// Pull-To-Refresh Implementation (Mobile 120Hz touch handling)
function setupPullToRefresh() {
  const scrollEl = document.getElementById('main-scroll-view');
  const indicator = document.getElementById('pull-refresh-indicator');
  const label = document.getElementById('pull-label');
  const spinner = document.getElementById('pull-spinner');

  if (!scrollEl || !indicator) return;

  let startY = 0;
  let currentY = 0;
  let isPulling = false;
  const threshold = 65;

  scrollEl.addEventListener(
    'touchstart',
    (e) => {
      if (scrollEl.scrollTop <= 0) {
        startY = e.touches[0].clientY;
        isPulling = true;
      }
    },
    { passive: true }
  );

  scrollEl.addEventListener(
    'touchmove',
    (e) => {
      if (!isPulling || scrollEl.scrollTop > 0) return;
      currentY = e.touches[0].clientY;
      const pullDist = Math.max(0, currentY - startY);

      if (pullDist > 10) {
        const dampened = Math.min(threshold + 20, pullDist * 0.45);
        indicator.style.transform = `translateY(${dampened}px)`;
        indicator.style.opacity = `${Math.min(1, pullDist / threshold)}`;

        if (pullDist >= threshold) {
          if (label) label.textContent = 'Release to refresh';
        } else {
          if (label) label.textContent = 'Pull to refresh';
        }
      }
    },
    { passive: true }
  );

  scrollEl.addEventListener('touchend', async () => {
    if (!isPulling) return;
    const pullDist = currentY - startY;
    isPulling = false;

    if (pullDist >= threshold) {
      indicator.style.transform = `translateY(${threshold}px)`;
      if (label) label.textContent = 'Refreshing quotes...';
      spinner?.classList.add('animate-spin-fast');

      await refreshLiveQuotes();

      spinner?.classList.remove('animate-spin-fast');
      indicator.style.opacity = '0';
      indicator.style.transform = 'translateY(-24px)';
    } else {
      indicator.style.opacity = '0';
      indicator.style.transform = 'translateY(-24px)';
    }
  });
}

// Live Quotes Refresh (Aggressive caching: min 15 mins)
async function refreshLiveQuotes(force = false) {
  if (!currentPortfolio || currentPortfolio.positions.length === 0) return;

  const statusText = document.getElementById('status-text');
  if (statusText) statusText.textContent = 'Updating...';

  try {
    const usdToEurRate = await getUsdToEurRate();
    if (!usdToEurRate || usdToEurRate <= 0) {
      if (statusText) statusText.textContent = 'Forex rate unavailable';
      console.warn(
        '[Currency Conversion] USD/EUR exchange rate unavailable from live API; keeping current real values without fabrication.'
      );
      return;
    }

    // Fetch quotes for all tickers (getQuoteForTicker converts USD to EUR at single entry point)
    for (const lot of currentPortfolio.positions) {
      if (!lot.currency) {
        lot.currency = detectPositionCurrency(lot.ticker);
      }

      const quote = await getQuoteForTicker(lot.ticker, force, lot.currency);
      if (quote && quote.price > 0) {
        // quote.price is ALREADY in EUR
        const priceInEur = quote.price;

        lot.currentPrice = Math.round(priceInEur * 1000) / 1000;
        lot.currentValue = Math.round(lot.volume * priceInEur * 100) / 100;
        lot.netProfitEur = Math.round((lot.currentValue - lot.volume * lot.openPrice) * 100) / 100;
        if (lot.openPrice > 0) {
          lot.netProfitPct = Math.round(((lot.currentPrice - lot.openPrice) / lot.openPrice) * 10000) / 100;
        }
        if (quote.monthChangePct !== undefined) {
          lot.monthChangePct = quote.monthChangePct;
        } else {
          lot.monthChangePct = lot.netProfitPct;
        }
      }
    }

    currentPortfolio.currentCapitalValue = Math.round(
      currentPortfolio.positions.reduce((acc, l) => acc + l.currentValue, 0) * 100
    ) / 100;

    // Update last point of net worth history to match current valuation
    if (currentPortfolio.netWorthHistory.length > 0) {
      const last = currentPortfolio.netWorthHistory[currentPortfolio.netWorthHistory.length - 1];
      last.value = currentPortfolio.currentCapitalValue;
    }

    currentPortfolio.lastQuotesUpdate = new Date().toISOString();
    lastUpdateTimestamp = Date.now();

    // Save updated portfolio strictly to Firestore in the cloud
    if (currentUser) {
      await savePortfolio(currentUser.uid, currentPortfolio);
    }

    renderDashboard();
  } catch (err) {
    console.error('Error refreshing quotes:', err);
    if (statusText) statusText.textContent = 'Sync error';
  }
}

// Pending Review Portfolio State
let pendingReviewLots: Lot[] = [];
let pendingReviewDeposits: Deposit[] = [];
let pendingReviewMoneyInvested = 0;
let pendingReviewHistory: NetWorthPoint[] = [];

// Open Review & Edit Modal
function openReviewModal(data: {
  positions?: Lot[];
  lots?: Lot[];
  deposits?: Deposit[];
  moneyInvested: number;
  netWorthHistory?: NetWorthPoint[];
}) {
  const sourceLots = data.positions || data.lots || [];
  pendingReviewLots = sourceLots.map((l) => ({ ...l }));
  pendingReviewDeposits = [...(data.deposits || [])];
  pendingReviewMoneyInvested = data.moneyInvested || 0;
  pendingReviewHistory = [...(data.netWorthHistory || [])];

  const modal = document.getElementById('review-modal');
  const countEl = document.getElementById('review-lots-count');
  const moneyInput = document.getElementById('review-money-invested') as HTMLInputElement;

  if (countEl) countEl.textContent = `${pendingReviewLots.length} lotes identificados`;
  if (moneyInput) moneyInput.value = pendingReviewMoneyInvested.toFixed(2);

  renderReviewLotsList();
  modal?.classList.remove('hidden');
}

function renderReviewLotsList() {
  const container = document.getElementById('review-lots-list');
  const countEl = document.getElementById('review-lots-count');
  if (countEl) countEl.textContent = `${pendingReviewLots.length} lotes identificados`;
  if (!container) return;

  if (pendingReviewLots.length === 0) {
    container.innerHTML = `
      <div class="text-center py-6 text-xs text-slate-400 border border-dashed border-slate-200 rounded-2xl">
        Nenhum lote. Toque em "+ Adicionar Lote" para incluir uma posição.
      </div>
    `;
    return;
  }

  container.innerHTML = pendingReviewLots
    .map((lot, idx) => {
      const subtotal = (lot.volume || 0) * (lot.currentPrice || 0);
      return `
      <div class="lot-edit-card bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-2.5" data-lot-idx="${idx}">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 flex-1">
            <input 
              type="text" 
              class="lot-ticker-input uppercase font-mono font-bold text-xs bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 w-24 text-slate-900 focus:outline-none focus:border-blue-500" 
              placeholder="TICKER" 
              value="${lot.ticker}" 
              data-idx="${idx}"
            />
            <select class="lot-category-select text-[11px] font-semibold bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-slate-600 focus:outline-none" data-idx="${idx}">
              <option value="STOCK" ${lot.category === 'STOCK' ? 'selected' : ''}>Ação</option>
              <option value="ETF" ${lot.category === 'ETF' ? 'selected' : ''}>ETF</option>
              <option value="CRYPTO" ${lot.category === 'CRYPTO' ? 'selected' : ''}>Crypto</option>
              <option value="COMMODITY" ${lot.category === 'COMMODITY' ? 'selected' : ''}>Commodity</option>
            </select>
          </div>
          <button type="button" class="remove-lot-btn p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 active:scale-95 transition-colors" data-idx="${idx}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>

        <div class="grid grid-cols-3 gap-2 text-left">
          <div>
            <label class="text-[10px] font-semibold text-slate-400 block mb-0.5">Qtd / Volume</label>
            <input 
              type="number" 
              step="any" 
              class="lot-volume-input w-full bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-semibold text-slate-900 focus:outline-none focus:border-blue-500" 
              value="${lot.volume}" 
              data-idx="${idx}"
            />
          </div>
          <div>
            <label class="text-[10px] font-semibold text-slate-400 block mb-0.5">Compra (€)</label>
            <input 
              type="number" 
              step="any" 
              class="lot-openprice-input w-full bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-semibold text-slate-900 focus:outline-none focus:border-blue-500" 
              value="${lot.openPrice}" 
              data-idx="${idx}"
            />
          </div>
          <div>
            <label class="text-[10px] font-semibold text-slate-400 block mb-0.5">Atual (€)</label>
            <input 
              type="number" 
              step="any" 
              class="lot-currprice-input w-full bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-xs font-semibold text-slate-900 focus:outline-none focus:border-blue-500" 
              value="${lot.currentPrice}" 
              data-idx="${idx}"
            />
          </div>
        </div>

        <div class="flex items-center justify-between pt-1 text-[11px] text-slate-500 border-t border-slate-200/60 font-medium">
          <span>Subtotal posição:</span>
          <span class="font-bold text-slate-900" id="lot-subtotal-${idx}">€${subtotal.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
      </div>
    `;
    })
    .join('');

  // Event Listeners for inline lot changes
  container.querySelectorAll('.lot-ticker-input').forEach((input) => {
    input.addEventListener('input', (e: any) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (pendingReviewLots[idx]) {
        pendingReviewLots[idx].ticker = e.target.value.trim().toUpperCase();
      }
    });
  });

  container.querySelectorAll('.lot-category-select').forEach((sel) => {
    sel.addEventListener('change', (e: any) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (pendingReviewLots[idx]) {
        pendingReviewLots[idx].category = e.target.value;
      }
    });
  });

  container.querySelectorAll('.lot-volume-input').forEach((input) => {
    input.addEventListener('input', (e: any) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const val = parseFloat(e.target.value) || 0;
      if (pendingReviewLots[idx]) {
        pendingReviewLots[idx].volume = val;
        pendingReviewLots[idx].currentValue =
          Math.round(val * pendingReviewLots[idx].currentPrice * 100) / 100;
        updateLotSubtotal(idx);
      }
    });
  });

  container.querySelectorAll('.lot-openprice-input').forEach((input) => {
    input.addEventListener('input', (e: any) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const val = parseFloat(e.target.value) || 0;
      if (pendingReviewLots[idx]) {
        pendingReviewLots[idx].openPrice = val;
      }
    });
  });

  container.querySelectorAll('.lot-currprice-input').forEach((input) => {
    input.addEventListener('input', (e: any) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const val = parseFloat(e.target.value) || 0;
      if (pendingReviewLots[idx]) {
        pendingReviewLots[idx].currentPrice = val;
        pendingReviewLots[idx].currentValue =
          Math.round(val * pendingReviewLots[idx].volume * 100) / 100;
        updateLotSubtotal(idx);
      }
    });
  });

  container.querySelectorAll('.remove-lot-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-idx') || '-1', 10);
      if (idx >= 0 && idx < pendingReviewLots.length) {
        pendingReviewLots.splice(idx, 1);
        renderReviewLotsList();
      }
    });
  });
}

function updateLotSubtotal(idx: number) {
  const lot = pendingReviewLots[idx];
  if (!lot) return;
  const subtotalEl = document.getElementById(`lot-subtotal-${idx}`);
  if (subtotalEl) {
    const total = lot.volume * lot.currentPrice;
    subtotalEl.textContent = `€${total.toLocaleString('pt-PT', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
}

function addNewLotToReview() {
  const todayIso = new Date().toISOString().split('T')[0];
  pendingReviewLots.push({
    positionId: `custom-${Date.now()}`,
    ticker: 'NOVO',
    name: 'Ativo Adicionado',
    category: 'STOCK',
    volume: 1,
    openPrice: 50,
    currentPrice: 50,
    currentValue: 50,
    openTime: todayIso,
    netProfitEur: 0,
    netProfitPct: 0,
    currency: 'EUR',
  });
  renderReviewLotsList();
}

async function saveConfirmedReviewPortfolio() {
  const moneyInput = document.getElementById('review-money-invested') as HTMLInputElement;
  const moneyInvested = Math.abs(parseFloat(moneyInput?.value || '0')) || 0;

  // Filter valid lots
  const validLots = pendingReviewLots.filter((l) => l.ticker && l.volume > 0);
  if (validLots.length === 0) {
    showError('Atenção', 'A carteira precisa ter pelo menos um lote com ticker e volume válidos.');
    return;
  }

  // Calculate current capital value: ONLY the market value of stocks
  const currentCapitalValue = validLots.reduce(
    (acc, l) => acc + l.volume * l.currentPrice,
    0
  );

  // Close review drawer
  document.getElementById('review-modal')?.classList.add('hidden');

  // Show quick saving modal with progress
  const modal = document.getElementById('processing-modal');
  const statusEl = document.getElementById('processing-status-text');
  const percentEl = document.getElementById('processing-percent-text');
  const barEl = document.getElementById('processing-progress-bar');
  modal?.classList.remove('hidden');
  if (statusEl) statusEl.textContent = 'Atualizando gráficos e salvando...';
  if (percentEl) percentEl.textContent = '100%';
  if (barEl) barEl.style.width = '100%';

  const todayStr = new Date().toISOString().split('T')[0];
  let updatedHistory = [...pendingReviewHistory];
  if (updatedHistory.length === 0) {
    updatedHistory = [{ date: todayStr, value: Math.round(currentCapitalValue * 100) / 100 }];
  } else {
    updatedHistory[updatedHistory.length - 1].value = Math.round(currentCapitalValue * 100) / 100;
  }

  const portfolioData: PortfolioData = {
    userId: currentUser?.uid || 'anon',
    updatedAt: new Date().toISOString(),
    moneyInvested: Math.round(moneyInvested * 100) / 100,
    currentCapitalValue: Math.round(currentCapitalValue * 100) / 100,
    positions: validLots,
    deposits:
      pendingReviewDeposits.length > 0
        ? pendingReviewDeposits
        : [{ amount: moneyInvested, date: todayStr }],
    netWorthHistory: updatedHistory,
    lastQuotesUpdate: new Date().toISOString(),
  };

  if (currentUser) {
    await savePortfolio(currentUser.uid, portfolioData);
  }

  currentPortfolio = portfolioData;
  lastUpdateTimestamp = Date.now();
  modal?.classList.add('hidden');
  renderDashboard();
}

// Handle Excel Upload with Minimal Progress Bar & Auto-Review Menu
async function handleExcelUpload(file: File) {
  const modal = document.getElementById('processing-modal');
  const statusEl = document.getElementById('processing-status-text');
  const percentEl = document.getElementById('processing-percent-text');
  const barEl = document.getElementById('processing-progress-bar');

  modal?.classList.remove('hidden');
  if (statusEl) statusEl.textContent = 'Lendo ficheiro...';
  if (percentEl) percentEl.textContent = '0%';
  if (barEl) barEl.style.width = '0%';

  try {
    const parsed = await parseGetquinFile(file, currentUser?.uid, (msg, pct) => {
      if (statusEl) statusEl.textContent = msg;
      if (percentEl) percentEl.textContent = `${pct}%`;
      if (barEl) barEl.style.width = `${pct}%`;
    });

    if (parsed.lots.length === 0) {
      showError(
        'Nenhuma Posição Encontrada',
        'Não foi possível encontrar lotes válidos no ficheiro Excel. Certifique-se de exportar a aba de posições abertas do Getquin.'
      );
      return;
    }

    // Brief smooth transition at 100%
    if (percentEl) percentEl.textContent = '100%';
    if (barEl) barEl.style.width = '100%';
    if (statusEl) statusEl.textContent = 'Pronto!';
    await new Promise((r) => setTimeout(r, 350));

    // Hide progress modal and open review bottom sheet
    modal?.classList.add('hidden');
    openReviewModal(parsed);
  } catch (err: any) {
    console.error('Upload failed:', err);
    showError(
      'Falha no Carregamento',
      err?.message || 'Não foi possível ler o ficheiro Excel do Getquin.'
    );
  } finally {
    modal?.classList.add('hidden');
    const fileInput = document.getElementById('excel-upload-input') as HTMLInputElement;
    if (fileInput) fileInput.value = '';
  }
}

// Load realistic sample Getquin portfolio if user tests without an export file
async function loadSampleData() {
  const modal = document.getElementById('processing-modal');
  const statusEl = document.getElementById('processing-status-text');
  modal?.classList.remove('hidden');
  if (statusEl) statusEl.textContent = 'Generating sample Getquin portfolio...';

  const today = new Date();
  const deposits: Deposit[] = [
    { amount: 5000, date: '2023-01-15 10:00' },
    { amount: 1500, date: '2023-06-20 09:30' },
    { amount: 1000, date: '2023-06-22 15:45' }, // Same calendar week (Mon-Sun) to demonstrate grouping
    { amount: 3000, date: '2023-11-10 11:20' },
    { amount: 1500, date: '2024-03-05 16:30' },
  ];

  const lots: Lot[] = [
    {
      positionId: 'VUAA-2023-01',
      ticker: 'VUAA',
      name: 'Vanguard S&P 500 UCITS ETF',
      category: 'ETF',
      volume: 45,
      currentValue: 4185.0,
      currentPrice: 93.0,
      openPrice: 72.5,
      openTime: '2023-01-15',
      netProfitEur: 922.5,
      netProfitPct: 28.27,
      currency: 'EUR',
      monthChangePct: 3.4,
    },
    {
      positionId: 'AAPL-2023-06',
      ticker: 'AAPL',
      name: 'Apple Inc.',
      category: 'STOCK',
      volume: 18,
      currentValue: 3564.0,
      currentPrice: 198.0,
      openPrice: 165.0,
      openTime: '2023-06-20',
      netProfitEur: 594.0,
      netProfitPct: 20.0,
      currency: 'USD',
      monthChangePct: 4.8,
    },
    {
      positionId: 'MSFT-2023-11',
      ticker: 'MSFT',
      name: 'Microsoft Corp.',
      category: 'STOCK',
      volume: 10,
      currentValue: 4120.0,
      currentPrice: 412.0,
      openPrice: 340.0,
      openTime: '2023-11-10',
      netProfitEur: 720.0,
      netProfitPct: 21.17,
      currency: 'USD',
      monthChangePct: 2.1,
    },
    {
      positionId: 'EGLN-2024-03',
      ticker: 'EGLN',
      name: 'iShares Physical Gold ETC',
      category: 'ETC',
      volume: 35,
      currentValue: 1680.0,
      currentPrice: 48.0,
      openPrice: 42.0,
      openTime: '2024-03-05',
      netProfitEur: 210.0,
      netProfitPct: 14.28,
      currency: 'EUR',
      monthChangePct: 6.2,
    },
    {
      positionId: 'NVDA-2024-01',
      ticker: 'NVDA',
      name: 'NVIDIA Corp.',
      category: 'STOCK',
      volume: 8,
      currentValue: 960.0,
      currentPrice: 120.0,
      openPrice: 55.0,
      openTime: '2024-01-10',
      netProfitEur: 520.0,
      netProfitPct: 118.18,
      currency: 'USD',
      monthChangePct: 8.9,
    },
    {
      positionId: 'TSLA-2023-09',
      ticker: 'TSLA',
      name: 'Tesla Inc.',
      category: 'STOCK',
      volume: 12,
      currentValue: 2400.0,
      currentPrice: 200.0,
      openPrice: 250.0,
      openTime: '2023-09-12',
      netProfitEur: -600.0,
      netProfitPct: -20.0,
      currency: 'USD',
      monthChangePct: -7.5,
    },
    {
      positionId: 'NKE-2024-02',
      ticker: 'NKE',
      name: 'Nike Inc.',
      category: 'STOCK',
      volume: 15,
      currentValue: 1200.0,
      currentPrice: 80.0,
      openPrice: 105.0,
      openTime: '2024-02-14',
      netProfitEur: -375.0,
      netProfitPct: -23.8,
      currency: 'USD',
      monthChangePct: -4.2,
    },
    {
      positionId: 'BABA-2023-10',
      ticker: 'BABA',
      name: 'Alibaba Group',
      category: 'STOCK',
      volume: 20,
      currentValue: 1500.0,
      currentPrice: 75.0,
      openPrice: 88.0,
      openTime: '2023-10-05',
      netProfitEur: -260.0,
      netProfitPct: -14.77,
      currency: 'USD',
      monthChangePct: -3.1,
    },
  ];

  // Reconstruct series at 4-hour granularity
  const netWorthHistory: NetWorthPoint[] = [];
  const start = new Date('2023-01-15T00:00:00');
  const end = new Date();
  const stepMs = 4 * 60 * 60 * 1000;
  let curr = new Date(start);

  let baseline = 5000;
  while (curr.getTime() <= end.getTime()) {
    const timeIso = curr.toISOString();
    const pointDateStr = timeIso.replace('T', ' ').substring(0, 16);
    const dayStr = timeIso.split('T')[0];

    if (dayStr === '2023-06-20' && curr.getHours() === 12) baseline += 1500;
    if (dayStr === '2023-06-22' && curr.getHours() === 16) baseline += 1000;
    if (dayStr === '2023-11-10' && curr.getHours() === 12) baseline += 3000;
    if (dayStr === '2024-03-05' && curr.getHours() === 16) baseline += 1500;

    const progressRatio =
      (curr.getTime() - start.getTime()) / (end.getTime() - start.getTime());
    // Smooth growth with market fluctuation
    const growth = baseline * (1 + 0.35 * progressRatio);
    const noise = Math.sin(progressRatio * 30) * 180 + Math.cos(progressRatio * 15) * 120;

    netWorthHistory.push({
      date: pointDateStr,
      value: Math.round((growth + noise) * 100) / 100,
    });
    curr.setTime(curr.getTime() + stepMs);
  }

  const moneyInvested = deposits.reduce((acc, d) => acc + d.amount, 0);
  const currentCapitalValue = lots.reduce((acc, l) => acc + l.currentValue, 0);
  netWorthHistory[netWorthHistory.length - 1].value = currentCapitalValue;

  const samplePortfolio: PortfolioData = {
    userId: currentUser?.uid || 'sample',
    updatedAt: new Date().toISOString(),
    moneyInvested,
    currentCapitalValue,
    positions: lots,
    deposits,
    netWorthHistory,
    lastQuotesUpdate: new Date().toISOString(),
  };

  if (currentUser) {
    await savePortfolio(currentUser.uid, samplePortfolio);
  }

  currentPortfolio = samplePortfolio;
  lastUpdateTimestamp = Date.now();
  modal?.classList.add('hidden');
  renderDashboard();
}

// Check and fetch incremental historical gap since last cached date
async function syncIncrementalHistoryIfNeeded(
  portfolio: PortfolioData,
  userId: string
): Promise<boolean> {
  if (!portfolio || !portfolio.positions || portfolio.positions.length === 0) return false;
  if (!portfolio.netWorthHistory || portfolio.netWorthHistory.length === 0) return false;

  const lastPoint = portfolio.netWorthHistory[portfolio.netWorthHistory.length - 1];
  const lastTime = new Date(lastPoint.date.replace(' ', 'T')).getTime();
  const nowTime = Date.now();
  const hoursSinceLastPoint = (nowTime - lastTime) / (1000 * 60 * 60);

  // If last point was recorded within 4 hours, no new interval has completed
  if (hoursSinceLastPoint < 4) {
    console.log(
      `[History Cache Hit] Last 4-hour point is recent (${lastPoint.date}, ${Math.round(
        hoursSinceLastPoint * 10
      ) / 10}h ago). Zero historical API calls needed.`
    );
    return false;
  }

  console.log(
    `[History Gap Sync] Gap detected since ${lastPoint.date} (~${Math.round(
      hoursSinceLastPoint
    )} hours). Fetching only missing incremental intervals...`
  );

  const usdToEurRate = await getUsdToEurRate();
  const uniqueTickers = Array.from(
    new Set(portfolio.positions.map((p) => p.ticker.trim().toUpperCase()))
  );
  const tickerHistoryMap: Map<string, Array<{ time: number; close: number }>> = new Map();

  for (const ticker of uniqueTickers) {
    try {
      const series = await fetchTickerHistorySmart(ticker, userId);
      if (series && series.length > 0) {
        tickerHistoryMap.set(
          ticker,
          series.map((pt) => ({
            time: new Date(pt.date.replace(' ', 'T')).getTime(),
            close: pt.close,
          }))
        );
      }
    } catch (e) {
      console.warn(`Error updating incremental history for ${ticker}:`, e);
    }
  }

  // Synthesize missing 4-hour points starting from next interval after lastPoint
  const stepMs = 4 * 60 * 60 * 1000;
  let currTime = lastTime + stepMs;
  let newPointsAdded = 0;

  while (currTime <= nowTime) {
    const timeIso = new Date(currTime).toISOString();
    const pointDateStr = timeIso.replace('T', ' ').substring(0, 16);
    const dayPrefix = timeIso.split('T')[0];

    const activeLots = portfolio.positions.filter(
      (l) => l.openTime <= dayPrefix || l.openTime <= pointDateStr
    );

    let pointVal = 0;
    for (const lot of activeLots) {
      const historyList = tickerHistoryMap.get(lot.ticker);
      let lotPrice = 0;
      if (historyList && historyList.length > 0) {
        for (let idx = historyList.length - 1; idx >= 0; idx--) {
          if (historyList[idx].time <= currTime) {
            lotPrice = historyList[idx].close;
            break;
          }
        }
        if (lotPrice <= 0) lotPrice = historyList[0].close;
      }
      if (lotPrice <= 0) {
        lotPrice = lot.currentPrice;
      }
      pointVal += lot.volume * lotPrice;
    }

    portfolio.netWorthHistory.push({
      date: pointDateStr,
      value: Math.round(pointVal * 100) / 100,
    });
    newPointsAdded++;
    currTime += stepMs;
  }

  if (newPointsAdded > 0) {
    portfolio.netWorthHistory[portfolio.netWorthHistory.length - 1].value =
      portfolio.currentCapitalValue;
    console.log(
      `[History Sync Complete] Appended ${newPointsAdded} missing 4-hour points to Net Worth series. Total points: ${portfolio.netWorthHistory.length}.`
    );
    await savePortfolio(userId, portfolio);
    return true;
  }

  return false;
}

// App Initialization Sequence
async function initializeApp() {
  // Check online status immediately
  if (!navigator.onLine) {
    showOfflineScreen();
    return;
  }

  showSplashScreen();

  try {
    // 1. Validate connection test
    await testConnection();

    // 2. Anonymous authentication silently in background
    currentUser = await initAuth();

    // 3. Load user portfolio strictly from Firestore in the cloud
    if (currentUser) {
      currentPortfolio = await loadPortfolio(currentUser.uid);
      if (currentPortfolio && currentPortfolio.positions && currentPortfolio.positions.length > 0) {
        let needsCorrection = false;
        for (const lot of currentPortfolio.positions) {
          const detected = detectPositionCurrency(lot.ticker);
          if (lot.currency !== detected) {
            lot.currency = detected;
            needsCorrection = true;
          }
        }

        const THIRTY_MIN_MS = 30 * 60 * 1000;
        const lastUpdate = currentPortfolio.lastQuotesUpdate
          ? new Date(currentPortfolio.lastQuotesUpdate).getTime()
          : (currentPortfolio.updatedAt ? new Date(currentPortfolio.updatedAt).getTime() : 0);
        const isStale = Date.now() - lastUpdate >= THIRTY_MIN_MS;

        if (isStale || needsCorrection) {
          console.log(
            `[Quote Sync] Quotes are older than 30 minutes (or currency re-alignment needed). Fetching fresh live quotes...`
          );
          await refreshLiveQuotes(true);
        } else {
          console.log(
            `[Quote Sync] Quotes are fresh (updated ${Math.round((Date.now() - lastUpdate) / 60000)} min ago). Using cached online portfolio.`
          );
          lastUpdateTimestamp = lastUpdate;
          // Check if there is any gap since the last recorded historical date
          await syncIncrementalHistoryIfNeeded(currentPortfolio, currentUser.uid);
        }
      }
    }

    // 4. Render Dashboard
    renderDashboard();

    // Start relative time updater
    if (updateTimerInterval) clearInterval(updateTimerInterval);
    updateTimerInterval = setInterval(() => {
      const statusText = document.getElementById('status-text');
      if (statusText) {
        statusText.textContent = getRelativeTimeStr(lastUpdateTimestamp);
      }
    }, 30000);
  } catch (err) {
    console.error('Initialization error:', err);
    // If error occurs, render dashboard
    renderDashboard();
  }
}

// Connectivity change listeners
window.addEventListener('online', () => {
  if (!currentUser) {
    initializeApp();
  }
});

window.addEventListener('offline', () => {
  // Only switch to offline screen if loading without data
  if (!currentPortfolio) {
    showOfflineScreen();
  }
});

// Boot the application
initializeApp();
