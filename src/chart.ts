import type { NetWorthPoint, Deposit } from './types';

export type ChartPeriod = '1D' | '1W' | '1M' | '3M' | '1Y' | 'YTD' | 'CUSTOM';

export interface GroupedWeeklyDeposit {
  weekKey: string;
  weekStart: string; // YYYY-MM-DD (Monday)
  weekEnd: string; // YYYY-MM-DD (Sunday)
  displayDate: string;
  totalAmount: number;
  items: Array<{
    amount: number;
    date: string;
  }>;
}

export interface ChartTooltipData {
  date: string;
  value: number;
  investedValue: number;
  groupedDeposit?: GroupedWeeklyDeposit;
}

export interface ChartOptions {
  container: HTMLElement;
  points: NetWorthPoint[];
  deposits: Deposit[];
  accentColor?: string;
  onTooltipChange?: (data: ChartTooltipData | null) => void;
  onPeriodChange?: (period: ChartPeriod) => void;
  onRequestCustomRange?: () => void;
}

interface Point2D {
  x: number;
  y: number;
}

/**
 * Computes monotone cubic Hermite spline Bezier control points (Fritsch-Carlson algorithm).
 * Guarantees smooth curvature without any stair-stepping horizontal/vertical overshoot,
 * preserving genuine jumps while eliminating artificial steps between price points.
 */
function buildMonotoneCubicSpline(
  points: Point2D[]
): Array<{ cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }> {
  const n = points.length;
  if (n < 2) return [];

  // Secants
  const deltas: number[] = new Array(n - 1);
  const dxs: number[] = new Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    const dx = points[k + 1].x - points[k].x;
    const dy = points[k + 1].y - points[k].y;
    dxs[k] = dx;
    deltas[k] = dx !== 0 ? dy / dx : 0;
  }

  // Initial tangents
  const m: number[] = new Array(n);
  m[0] = deltas[0];
  m[n - 1] = deltas[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (deltas[k - 1] * deltas[k] <= 0) {
      m[k] = 0;
    } else {
      m[k] = (2 * deltas[k - 1] * deltas[k]) / (deltas[k - 1] + deltas[k]);
    }
  }

  // Fritsch-Carlson condition for monotonicity
  for (let k = 0; k < n - 1; k++) {
    if (deltas[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
    } else {
      const alpha = m[k] / deltas[k];
      const beta = m[k + 1] / deltas[k];
      const dist = alpha * alpha + beta * beta;
      if (dist > 9) {
        const tau = 3 / Math.sqrt(dist);
        m[k] = tau * alpha * deltas[k];
        m[k + 1] = tau * beta * deltas[k];
      }
    }
  }

  // Generate cubic Bezier segments
  const segments: Array<{ cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number }> = [];
  for (let k = 0; k < n - 1; k++) {
    const p0 = points[k];
    const p1 = points[k + 1];
    const thirdDx = dxs[k] / 3;
    segments.push({
      cp1x: p0.x + thirdDx,
      cp1y: p0.y + m[k] * thirdDx,
      cp2x: p1.x - thirdDx,
      cp2y: p1.y - m[k + 1] * thirdDx,
      x: p1.x,
      y: p1.y,
    });
  }

  return segments;
}

/**
 * Group deposits by calendar week (Monday to Sunday)
 */
export function groupDepositsByCalendarWeek(deposits: Deposit[]): GroupedWeeklyDeposit[] {
  const map = new Map<string, GroupedWeeklyDeposit>();

  const sorted = [...deposits].sort((a, b) => a.date.localeCompare(b.date));

  for (const dep of sorted) {
    if (!dep.amount || isNaN(dep.amount)) continue;
    const d = new Date(dep.date);
    if (isNaN(d.getTime())) continue;

    const day = d.getDay(); // 0 is Sunday, 1 is Monday
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const weekKey = monday.toISOString().split('T')[0];
    const weekStart = weekKey;
    const weekEnd = sunday.toISOString().split('T')[0];

    let group = map.get(weekKey);
    if (!group) {
      group = {
        weekKey,
        weekStart,
        weekEnd,
        displayDate: dep.date,
        totalAmount: 0,
        items: [],
      };
      map.set(weekKey, group);
    }

    group.totalAmount += dep.amount;
    // update display date to latest deposit date in that week
    group.displayDate = dep.date;
    group.items.push({
      amount: dep.amount,
      date: dep.date,
    });
  }

  return Array.from(map.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export class NetWorthChart {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private allPoints: NetWorthPoint[] = [];
  private allDeposits: Deposit[] = [];
  private groupedDeposits: GroupedWeeklyDeposit[] = [];

  // Period-filtered base points
  private periodPoints: NetWorthPoint[] = [];
  // Zoomed slice of points (between visibleStartIndex and visibleEndIndex)
  private visibleStartIndex = 0;
  private visibleEndIndex = 0;

  private period: ChartPeriod = '1M';
  private customStartDate: string | null = null;
  private customEndDate: string | null = null;
  private accentColor: string = '#0066FF';
  private onTooltipChange?: (data: ChartTooltipData | null) => void;

  // Touch & Interaction state
  private isInteracting = false;
  private touchX: number | null = null;
  private activeIndex: number | null = null;
  private activeGroupedDeposit: GroupedWeeklyDeposit | null = null;
  private resizeObserver: ResizeObserver;

  // Pinch-to-zoom state
  private isPinching = false;
  private initialPinchDist = 0;
  private initialPinchMidX = 0;
  private initialVisibleStart = 0;
  private initialVisibleEnd = 0;

  // Pan state when zoomed
  private isPanning = false;
  private lastPanX = 0;
  private lastTapTime = 0;

  constructor(options: ChartOptions) {
    this.container = options.container;
    this.allPoints = options.points;
    this.allDeposits = options.deposits;
    this.groupedDeposits = groupDepositsByCalendarWeek(options.deposits);
    this.accentColor = options.accentColor || '#0066FF';
    this.onTooltipChange = options.onTooltipChange;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'w-full h-full block select-none touch-none';
    this.canvas.style.touchAction = 'none';
    this.container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.setupEvents();
    this.filterPeriodPoints();
    this.resizeObserver = new ResizeObserver(() => this.resizeAndDraw());
    this.resizeObserver.observe(this.container);

    requestAnimationFrame(() => this.resizeAndDraw());
  }

  public setAccentColor(color: string) {
    this.accentColor = color;
    this.draw();
  }

  public updateData(points: NetWorthPoint[], deposits: Deposit[]) {
    this.allPoints = points;
    this.allDeposits = deposits;
    this.groupedDeposits = groupDepositsByCalendarWeek(deposits);
    this.filterPeriodPoints();
    this.draw();
  }

  public setPeriod(period: ChartPeriod, customStart?: string, customEnd?: string) {
    this.period = period;
    if (customStart && customEnd) {
      this.customStartDate = customStart;
      this.customEndDate = customEnd;
    }
    this.filterPeriodPoints();
    this.draw();
  }

  public resetZoom() {
    this.visibleStartIndex = 0;
    this.visibleEndIndex = Math.max(0, this.periodPoints.length - 1);
    this.draw();
  }

  public isZoomed(): boolean {
    if (this.periodPoints.length <= 1) return false;
    return (
      this.visibleStartIndex > 0 ||
      this.visibleEndIndex < this.periodPoints.length - 1
    );
  }

  private filterPeriodPoints() {
    if (this.allPoints.length === 0) {
      this.periodPoints = [];
      this.visibleStartIndex = 0;
      this.visibleEndIndex = 0;
      return;
    }

    const now = new Date();
    let cutoff = new Date();

    if (this.period === '1D') {
      cutoff.setTime(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (this.period === '1W') {
      cutoff.setTime(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (this.period === '1M') {
      cutoff.setMonth(now.getMonth() - 1);
    } else if (this.period === '3M') {
      cutoff.setMonth(now.getMonth() - 3);
    } else if (this.period === '1Y') {
      cutoff.setFullYear(now.getFullYear() - 1);
    } else if (this.period === 'YTD') {
      cutoff = new Date(now.getFullYear(), 0, 1);
    } else if (this.period === 'CUSTOM' && this.customStartDate && this.customEndDate) {
      const startIso = this.customStartDate;
      const endIso = this.customEndDate;
      this.periodPoints = this.allPoints.filter(
        (p) => p.date >= startIso && p.date <= endIso + ' 23:59'
      );
      if (this.periodPoints.length === 0) {
        this.periodPoints = [...this.allPoints];
      }
      this.visibleStartIndex = 0;
      this.visibleEndIndex = this.periodPoints.length - 1;
      return;
    }

    const cutoffIso = cutoff.toISOString().replace('T', ' ').substring(0, 16);
    this.periodPoints = this.allPoints.filter((p) => p.date >= cutoffIso);

    // Fallback if range has too few points
    if (this.periodPoints.length < 2 && this.allPoints.length >= 2) {
      this.periodPoints = this.allPoints.slice(-Math.min(12, this.allPoints.length));
    } else if (this.periodPoints.length === 0) {
      this.periodPoints = [...this.allPoints];
    }

    if (this.period === '1M') {
      const count = this.periodPoints.length;
      console.log(
        `[Chart Density Check - 1M] Plotted points: ${count} (expected ~180 points for 30 days @ 4h intervals). Density status: ${
          count >= 150 ? 'Optimal dense curve' : 'Warning: sparser than expected'
        }`
      );
      if (count < 100) {
        console.warn(
          `[Chart Density Warning - 1M] Range has ${count} points instead of ~180. Check if portfolio history starts fewer than 30 days ago, or if market history returned limited points.`
        );
      }
    }

    this.visibleStartIndex = 0;
    this.visibleEndIndex = this.periodPoints.length - 1;
  }

  private getActivePoints(): NetWorthPoint[] {
    if (this.periodPoints.length === 0) return [];
    const start = Math.max(0, Math.min(this.visibleStartIndex, this.periodPoints.length - 1));
    const end = Math.max(start, Math.min(this.visibleEndIndex, this.periodPoints.length - 1));
    return this.periodPoints.slice(start, end + 1);
  }

  /**
   * Cumulative Invested Capital up to dateStr
   */
  private getInvestedCapitalAt(dateStr: string): number {
    let sum = 0;
    for (const dep of this.allDeposits) {
      if (dep.date <= dateStr || dep.date.split(' ')[0] <= dateStr.split(' ')[0]) {
        sum += dep.amount;
      }
    }
    return sum;
  }

  private setupEvents() {
    const handleSingleMove = (clientX: number) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      this.touchX = Math.max(0, Math.min(x, rect.width));
      this.isInteracting = true;
      this.updateActivePoint();
      this.draw();
    };

    const handleEnd = () => {
      this.isInteracting = false;
      this.isPinching = false;
      this.isPanning = false;
      this.touchX = null;
      this.activeIndex = null;
      this.activeGroupedDeposit = null;
      this.onTooltipChange?.(null);
      this.draw();
    };

    // Touch events for mobile (Pinch-to-zoom, Pan, and Scrub)
    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        const now = Date.now();
        if (now - this.lastTapTime < 300) {
          // Double tap to reset zoom
          this.resetZoom();
          this.lastTapTime = 0;
          return;
        }
        this.lastTapTime = now;

        if (e.touches.length === 2) {
          // Start pinch-to-zoom
          this.isPinching = true;
          this.isInteracting = false;
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          this.initialPinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
          this.initialPinchMidX = (t1.clientX + t2.clientX) / 2;
          this.initialVisibleStart = this.visibleStartIndex;
          this.initialVisibleEnd = this.visibleEndIndex;
        } else if (e.touches.length === 1) {
          this.isPinching = false;
          this.lastPanX = e.touches[0].clientX;
          handleSingleMove(e.touches[0].clientX);
        }
      },
      { passive: true }
    );

    this.canvas.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2 && this.isPinching) {
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
          const currentMidX = (t1.clientX + t2.clientX) / 2;

          if (this.initialPinchDist > 0 && currentDist > 0) {
            const scale = currentDist / this.initialPinchDist; // > 1 means pinching out (zoom in)
            const initialSpan = this.initialVisibleEnd - this.initialVisibleStart;
            const newSpan = Math.round(initialSpan / scale);

            const rect = this.canvas.getBoundingClientRect();
            const paddingX = 20;
            const chartW = Math.max(1, rect.width - paddingX * 2);
            const ratio = Math.max(0, Math.min(1, (this.initialPinchMidX - rect.left - paddingX) / chartW));
            const centerIndex = this.initialVisibleStart + ratio * initialSpan;

            let newStart = Math.round(centerIndex - ratio * newSpan);
            let newEnd = newStart + newSpan;

            // Pan shift
            const deltaX = currentMidX - this.initialPinchMidX;
            const indexShift = Math.round((deltaX / chartW) * (newSpan || 10));
            newStart -= indexShift;
            newEnd -= indexShift;

            const minSpan = 6;
            const maxSpan = this.periodPoints.length - 1;

            if (newEnd - newStart < minSpan) {
              const diff = minSpan - (newEnd - newStart);
              newStart -= Math.floor(diff / 2);
              newEnd += Math.ceil(diff / 2);
            }

            if (newEnd - newStart > maxSpan) {
              newStart = 0;
              newEnd = maxSpan;
            }

            if (newStart < 0) {
              newEnd = Math.min(maxSpan, newEnd - newStart);
              newStart = 0;
            }
            if (newEnd > maxSpan) {
              newStart = Math.max(0, newStart - (newEnd - maxSpan));
              newEnd = maxSpan;
            }

            this.visibleStartIndex = Math.max(0, newStart);
            this.visibleEndIndex = Math.min(maxSpan, newEnd);
            this.draw();
          }
        } else if (e.touches.length === 1 && !this.isPinching) {
          handleSingleMove(e.touches[0].clientX);
        }
      },
      { passive: true }
    );

    this.canvas.addEventListener('touchend', (e) => {
      if (e.touches.length === 0) {
        handleEnd();
      } else if (e.touches.length === 1) {
        this.isPinching = false;
      }
    }, { passive: true });

    this.canvas.addEventListener('touchcancel', handleEnd, { passive: true });

    // Mouse fallback events
    this.canvas.addEventListener('mousemove', (e) => {
      handleSingleMove(e.clientX);
    });
    this.canvas.addEventListener('mouseleave', handleEnd);

    // Mouse wheel zoom (desktop)
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const paddingX = 20;
        const chartW = Math.max(1, rect.width - paddingX * 2);
        const mouseX = e.clientX - rect.left - paddingX;
        const ratio = Math.max(0, Math.min(1, mouseX / chartW));

        const span = this.visibleEndIndex - this.visibleStartIndex;
        const zoomDelta = e.deltaY < 0 ? -Math.max(2, Math.round(span * 0.15)) : Math.max(2, Math.round(span * 0.15));
        const newSpan = Math.max(6, Math.min(this.periodPoints.length - 1, span + zoomDelta));

        const centerIndex = this.visibleStartIndex + ratio * span;
        let newStart = Math.round(centerIndex - ratio * newSpan);
        let newEnd = newStart + newSpan;

        const maxSpan = this.periodPoints.length - 1;
        if (newStart < 0) {
          newEnd -= newStart;
          newStart = 0;
        }
        if (newEnd > maxSpan) {
          newStart -= newEnd - maxSpan;
          newEnd = maxSpan;
        }

        this.visibleStartIndex = Math.max(0, newStart);
        this.visibleEndIndex = Math.min(maxSpan, newEnd);
        this.draw();
      },
      { passive: false }
    );
  }

  private updateActivePoint() {
    const activePoints = this.getActivePoints();
    if (!this.touchX || activePoints.length === 0) return;
    const width = this.canvas.clientWidth;
    const padding = 20;
    const chartW = width - padding * 2;

    const ratio = Math.max(0, Math.min(1, (this.touchX - padding) / chartW));
    const index = Math.round(ratio * (activePoints.length - 1));
    this.activeIndex = index;

    const pt = activePoints[index];
    if (!pt) return;

    // Check if near a weekly deposit
    const ptDateOnly = pt.date.split(' ')[0];
    const matchingWeeklyDeposit =
      this.groupedDeposits.find(
        (g) => ptDateOnly >= g.weekStart && ptDateOnly <= g.weekEnd
      ) || null;

    this.activeGroupedDeposit = matchingWeeklyDeposit;
    const invested = this.getInvestedCapitalAt(pt.date);

    this.onTooltipChange?.({
      date: pt.date,
      value: pt.value,
      investedValue: invested,
      groupedDeposit: matchingWeeklyDeposit || undefined,
    });
  }

  public resizeAndDraw() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(280, Math.floor(rect.width));
    const height = Math.max(180, Math.floor(rect.height));

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.ctx.resetTransform?.();
    this.ctx.scale(dpr, dpr);

    this.draw();
  }

  public draw() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    const activePoints = this.getActivePoints();
    if (activePoints.length === 0) {
      ctx.fillStyle = '#94A3B8';
      ctx.font = '14px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No historical data available for this range', width / 2, height / 2);
      return;
    }

    const paddingX = 20;
    const paddingTop = 26;
    const paddingBottom = 32;
    const chartW = width - paddingX * 2;
    const chartH = height - paddingTop - paddingBottom;

    // Compute invested capital for each active point to determine unified scale
    const investedSeries: number[] = activePoints.map((p) => this.getInvestedCapitalAt(p.date));

    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < activePoints.length; i++) {
      const netVal = activePoints[i].value;
      const invVal = investedSeries[i];
      if (netVal < minVal) minVal = netVal;
      if (netVal > maxVal) maxVal = netVal;
      if (invVal > 0 && invVal < minVal) minVal = invVal;
      if (invVal > maxVal) maxVal = invVal;
    }

    if (minVal === maxVal) {
      minVal = Math.max(0, minVal - 100);
      maxVal = maxVal + 100;
    }

    const range = maxVal - minVal;
    const padVal = range * 0.08;
    const effectiveMin = Math.max(0, minVal - padVal);
    const effectiveMax = maxVal + padVal;
    const effectiveRange = effectiveMax - effectiveMin || 1;

    // Coordinate mapping functions
    const getX = (i: number) => paddingX + (i / (activePoints.length - 1 || 1)) * chartW;
    const getY = (val: number) => paddingTop + chartH - ((val - effectiveMin) / effectiveRange) * chartH;

    // 1. Draw horizontal grid lines and Y-axis labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#F1F5F9';
    const gridSteps = 3;
    for (let i = 0; i <= gridSteps; i++) {
      const gVal = effectiveMin + (effectiveRange / gridSteps) * i;
      const y = getY(gVal);

      ctx.beginPath();
      ctx.moveTo(paddingX, y);
      ctx.lineTo(width - paddingX, y);
      ctx.stroke();

      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`€${Math.round(gVal).toLocaleString('de-DE')}`, width - paddingX, y - 6);
    }

    // 2. Prepare Monotone Spline points for Net Worth curve
    const netPoints2D: Point2D[] = activePoints.map((p, idx) => ({
      x: getX(idx),
      y: getY(p.value),
    }));

    const splineSegments = buildMonotoneCubicSpline(netPoints2D);

    // 3. Draw gradient fill under the smooth Net Worth curve
    const gradient = ctx.createLinearGradient(0, paddingTop, 0, height - paddingBottom);
    gradient.addColorStop(0, `${this.accentColor}25`); // 15% opacity
    gradient.addColorStop(1, `${this.accentColor}00`); // 0% opacity

    ctx.beginPath();
    ctx.moveTo(netPoints2D[0].x, height - paddingBottom);
    ctx.lineTo(netPoints2D[0].x, netPoints2D[0].y);

    for (const seg of splineSegments) {
      ctx.bezierCurveTo(seg.cp1x, seg.cp1y, seg.cp2x, seg.cp2y, seg.x, seg.y);
    }
    ctx.lineTo(netPoints2D[netPoints2D.length - 1].x, height - paddingBottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 4. Draw INVESTED CAPITAL LINE (Smooth Monotone Cubic Spline continuous curve)
    const investedPoints2D: Point2D[] = activePoints.map((_, idx) => ({
      x: getX(idx),
      y: getY(investedSeries[idx]),
    }));
    const investedSplineSegments = buildMonotoneCubicSpline(investedPoints2D);

    ctx.beginPath();
    ctx.moveTo(investedPoints2D[0].x, investedPoints2D[0].y);
    if (investedSplineSegments.length > 0) {
      for (const seg of investedSplineSegments) {
        ctx.bezierCurveTo(seg.cp1x, seg.cp1y, seg.cp2x, seg.cp2y, seg.x, seg.y);
      }
    } else {
      for (let i = 1; i < investedPoints2D.length; i++) {
        ctx.lineTo(investedPoints2D[i].x, investedPoints2D[i].y);
      }
    }
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 5. Draw SMOOTH NET WORTH LINE (Monotone cubic continuous trend)
    ctx.beginPath();
    ctx.moveTo(netPoints2D[0].x, netPoints2D[0].y);
    for (const seg of splineSegments) {
      ctx.bezierCurveTo(seg.cp1x, seg.cp1y, seg.cp2x, seg.cp2y, seg.x, seg.y);
    }
    ctx.strokeStyle = this.accentColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 6. Draw GROUPED DEPOSITS BY WEEK
    // Deposits in the same calendar week are combined into a single dot positioned at that week's point
    // Drawn along the Invested Capital line
    const minActiveDate = activePoints[0].date.split(' ')[0];
    const maxActiveDate = activePoints[activePoints.length - 1].date.split(' ')[0];

    const visibleWeeklyDeposits = this.groupedDeposits.filter(
      (g) => g.weekEnd >= minActiveDate && g.weekStart <= maxActiveDate
    );

    for (const group of visibleWeeklyDeposits) {
      // Find the closest active point within or closest to the group's week
      let bestIdx = -1;
      let minDiff = Infinity;
      const targetTime = new Date(group.displayDate).getTime();

      for (let i = 0; i < activePoints.length; i++) {
        const ptTime = new Date(activePoints[i].date).getTime();
        const diff = Math.abs(ptTime - targetTime);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = i;
        }
      }

      if (bestIdx !== -1) {
        const x = getX(bestIdx);
        const y = getY(investedSeries[bestIdx]);

        // If multiple deposits that week, draw subtle outer halo
        if (group.items.length > 1) {
          ctx.beginPath();
          ctx.arc(x, y, 7.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
          ctx.fill();
        }

        // Dot: Emerald fill with crisp white border
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#10B981';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
      }
    }

    // 7. Active Interaction: Hairline and detailed Tooltip
    if (this.isInteracting && this.activeIndex !== null && this.activeIndex < activePoints.length) {
      const pt = activePoints[this.activeIndex];
      const x = getX(this.activeIndex);
      const yNet = getY(pt.value);
      const yInv = getY(investedSeries[this.activeIndex]);

      // Vertical guideline
      ctx.beginPath();
      ctx.moveTo(x, paddingTop);
      ctx.lineTo(x, height - paddingBottom);
      ctx.strokeStyle = '#CBD5E1';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Invested capital dot on guideline
      ctx.beginPath();
      ctx.arc(x, yInv, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#94A3B8';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      // Net worth point circle
      ctx.beginPath();
      ctx.arc(x, yNet, 6, 0, Math.PI * 2);
      ctx.fillStyle = this.accentColor;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      // Tooltip construction
      const dateObj = new Date(pt.date);
      const dateFormatted = !isNaN(dateObj.getTime())
        ? dateObj.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: this.period === '1D' || this.period === '1W' ? undefined : 'numeric',
            hour: this.period === '1D' || this.period === '1W' ? '2-digit' : undefined,
            minute: this.period === '1D' || this.period === '1W' ? '2-digit' : undefined,
          })
        : pt.date;

      const netStr = `Net: €${pt.value.toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
      const invStr = `Invested: €${investedSeries[this.activeIndex].toLocaleString('de-DE', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })}`;

      const lines: string[] = [`${netStr} • ${invStr}`, dateFormatted];

      if (this.activeGroupedDeposit) {
        const dep = this.activeGroupedDeposit;
        lines.push(`Deposit: +€${dep.totalAmount.toLocaleString('de-DE')} (Week total)`);
        if (dep.items.length > 1) {
          dep.items.forEach((item) => {
            const itemTime = new Date(item.date).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            });
            lines.push(`• +€${item.amount.toLocaleString('de-DE')} (${itemTime})`);
          });
        }
      }

      // Measure tooltip dimensions
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      let maxLineWidth = 0;
      for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > maxLineWidth) maxLineWidth = w;
      }

      const lineHeight = 16;
      const pillW = maxLineWidth + 22;
      const pillH = lines.length * lineHeight + 12;

      let pillX = Math.max(8, Math.min(width - pillW - 8, x - pillW / 2));
      let pillY = Math.min(yNet, yInv) - pillH - 12;
      if (pillY < 4) {
        pillY = Math.max(yNet, yInv) + 14;
      }

      // Draw Tooltip Card
      ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(pillX, pillY, pillW, pillH, 8);
      } else {
        ctx.rect(pillX, pillY, pillW, pillH);
      }
      ctx.fill();

      // Tooltip Text rendering
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let l = 0; l < lines.length; l++) {
        const lineY = pillY + 10 + l * lineHeight + lineHeight / 2;
        if (l === 0) {
          ctx.fillStyle = '#38BDF8'; // Sky blue for Net & Invested
        } else if (lines[l].startsWith('Deposit:')) {
          ctx.fillStyle = '#34D399'; // Emerald for weekly deposit total
        } else if (lines[l].startsWith('•')) {
          ctx.fillStyle = '#CBD5E1'; // Soft gray for sub-deposits
        } else {
          ctx.fillStyle = '#94A3B8'; // Date label
        }
        ctx.fillText(lines[l], pillX + 11, lineY);
      }
    }

    // 8. Zoom indicator badge if currently zoomed
    if (this.isZoomed()) {
      const zoomText = 'Zoomed • Pinch out or double tap to reset';
      ctx.font = '500 9px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      const zoomW = ctx.measureText(zoomText).width + 16;
      const badgeX = width / 2 - zoomW / 2;
      const badgeY = 6;

      ctx.fillStyle = 'rgba(241, 245, 249, 0.9)';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(badgeX, badgeY, zoomW, 16, 8);
      } else {
        ctx.rect(badgeX, badgeY, zoomW, 16);
      }
      ctx.fill();

      ctx.fillStyle = '#475569';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(zoomText, width / 2, badgeY + 8);
    }

    // 9. Dates on bottom axis
    if (activePoints.length >= 2) {
      ctx.fillStyle = '#94A3B8';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
      ctx.textBaseline = 'top';

      const firstD = new Date(activePoints[0].date);
      const lastD = new Date(activePoints[activePoints.length - 1].date);

      const isShortRange = this.period === '1D' || this.period === '1W';
      const firstDateStr = !isNaN(firstD.getTime())
        ? firstD.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: isShortRange ? '2-digit' : undefined,
            minute: isShortRange ? '2-digit' : undefined,
          })
        : activePoints[0].date;

      const lastDateStr = !isNaN(lastD.getTime())
        ? lastD.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            hour: isShortRange ? '2-digit' : undefined,
            minute: isShortRange ? '2-digit' : undefined,
          })
        : activePoints[activePoints.length - 1].date;

      ctx.textAlign = 'left';
      ctx.fillText(firstDateStr, paddingX, height - paddingBottom + 8);

      ctx.textAlign = 'right';
      ctx.fillText(lastDateStr, width - paddingX, height - paddingBottom + 8);
    }
  }

  public destroy() {
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }
}
