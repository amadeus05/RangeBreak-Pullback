import { injectable, inject } from 'inversify';
import { IExchange } from '../../domain/interfaces/IExchange';
import { CandleRepository } from '../../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';
import { Candle } from '../../domain/entities/Candle';
import { Logger } from '../../shared/logger/Logger';
import { TYPES } from '../../config/types';
import { MomentumStrategy } from '../strategies/MomentumStrategy';
import { ExecutionEngine } from '../services/execution/ExecutionEngine';
import { PortfolioManager } from '../services/portfolio/PortfolioManager';
import { IRiskEngine } from '../../domain/interfaces/IRiskEngine';

export interface BacktestConfig {
    symbols: string[];
    days: number;
    initialBalance: number;
    startDay?: number;
    endDay?: number;
    slippageBps?: number;
}

export interface DirectionTradeStats {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
}

export interface MonthlyTradeStats {
    month: string;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
}

export interface SymbolTradeStats {
    symbol: string;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
}

export interface BacktestResult {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    finalBalance: number;
    maxDrawdown: number;
    profitFactor?: number;
    totalFees?: number;
    directionStats: {
        long: DirectionTradeStats;
        short: DirectionTradeStats;
    };
    monthlyStats: MonthlyTradeStats[];
    symbolStats: SymbolTradeStats[];
}

@injectable()
export class RunBacktest {
    private logger = Logger.getInstance();

    constructor(
        @inject(TYPES.MomentumStrategy) private readonly strategy: MomentumStrategy,
        @inject(TYPES.IDataFeed) private readonly dataFeed: IExchange,
        @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
        private readonly candleRepo: CandleRepository,
        private readonly tradeRepo: TradeRepository
    ) { }

    async execute(config: BacktestConfig): Promise<BacktestResult> {
        this.logger.info('Starting Multi-Symbol Synchronized Backtest', config);
        await this.tradeRepo.clearTrades();

        const endTime = Date.now();
        const startTime = endTime - (config.days * 24 * 60 * 60 * 1000);

        const dataMap: Map<string, { candles5m: Candle[], candles1m: Candle[] }> = new Map();

        // 1. Загружаем данные
        for (const symbol of config.symbols) {
            this.logger.info(`Checking data for ${symbol}...`);
            const c5 = await this.fetchHistoricalData(symbol, '5m', startTime, endTime);
            const c1 = await this.fetchHistoricalData(symbol, '1m', startTime, endTime);

            if (c5.length === 0 || c1.length === 0) {
                this.logger.warn(`No data found for ${symbol}. Skipping.`);
                continue;
            }
            this.logger.info(`${symbol}: Loaded ${c5.length} (5m) and ${c1.length} (1m) candles.`);
            dataMap.set(symbol, { candles5m: c5, candles1m: c1 });
        }

        const validSymbols = config.symbols.filter(s => dataMap.has(s));
        if (validSymbols.length === 0) return this.getEmptyResult(config.initialBalance);

        return this.runSynchronizedSimulation(
            validSymbols,
            dataMap,
            config.initialBalance,
            config.startDay,
            config.endDay,
            config.slippageBps
        );
    }

    private async fetchHistoricalData(
        symbol: string,
        timeframe: string,
        start: number,
        end: number
    ): Promise<Candle[]> {

        const cachedCount = await this.candleRepo.countInRange(symbol, timeframe, start, end);
        const expectedCount = Math.floor((end - start) / this.getTimeframeMs(timeframe));

        if (cachedCount >= expectedCount * 0.95) {
            this.logger.info(`[CACHE] ${symbol} ${timeframe}: Found ${cachedCount} candles in DB (expected ~${expectedCount})`);
            return await this.candleRepo.getCandles(symbol, timeframe, start, end);
        }

        const lastCandle = await this.candleRepo.getLastCandle(symbol, timeframe);
        let downloadStart = start;

        if (lastCandle && lastCandle.timestamp > start) {
            const dateStr = new Date(downloadStart).toISOString().replace('T', ' ').substring(0, 19);
            this.logger.info(`[CACHE] ${symbol} ${timeframe}: Resuming from ${dateStr}`);
        } else {
            this.logger.info(`[DOWNLOAD] ${symbol} ${timeframe}: Starting fresh download...`);
        }

        let curr = downloadStart;
        const LIMIT = 1000;
        const MAX_RETRIES = 3;
        const TIMEOUT_MS = 10000;
        let loopCount = 0;
        let totalDownloaded = 0;

        while (curr < end && loopCount < 500) {
            let retries = 0;
            let success = false;

            while (retries < MAX_RETRIES && !success) {
                try {
 
                    const batch = await Promise.race([
                        this.dataFeed.getCandles(symbol, timeframe, LIMIT, curr),
                        new Promise<null>((_, reject) =>
                            setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
                        )
                    ]);

                    if (!batch || batch.length === 0) {
                        this.logger.warn(`[DOWNLOAD] ${symbol} ${timeframe}: No more data available`);
                        break;
                    }

                    await this.candleRepo.saveCandles(batch);
                    totalDownloaded += batch.length;
                    curr = batch[batch.length - 1].timestamp + this.getTimeframeMs(timeframe);

                    if (loopCount % 5 === 0) {
                        this.logger.info(`[DOWNLOAD] ${symbol} ${timeframe}: ${totalDownloaded} candles downloaded...`);
                    }

                    if (batch[batch.length - 1].timestamp >= end) break;

                    await new Promise(r => setTimeout(r, 100)); // Rate limit
                    success = true;

                } catch (e: any) {
                    retries++;
                    if (e.message === 'Timeout') {
                        this.logger.warn(`[DOWNLOAD] ${symbol} ${timeframe}: Timeout (attempt ${retries}/${MAX_RETRIES})`);
                    } else {
                        this.logger.warn(`[DOWNLOAD] ${symbol} ${timeframe}: Error - ${e.message} (attempt ${retries}/${MAX_RETRIES})`);
                    }

                    if (retries >= MAX_RETRIES) {
                        this.logger.error(`[DOWNLOAD] ${symbol} ${timeframe}: Failed after ${MAX_RETRIES} retries, using cached data`);
                        break;
                    }

                    await new Promise(r => setTimeout(r, 1000 * retries)); // Exponential backoff
                }
            }

            if (!success) break;
            loopCount++;
        }

        if (totalDownloaded > 0) {
            this.logger.info(`[DOWNLOAD] ${symbol} ${timeframe}: Completed! Downloaded ${totalDownloaded} new candles`);
        }

        return await this.candleRepo.getCandles(symbol, timeframe, start, end);
    }

    private getTimeframeMs(tf: string): number {
        return tf === '5m' ? 5 * 60 * 1000 : 60 * 1000;
    }

    private async runSynchronizedSimulation(
        symbols: string[],
        dataMap: Map<string, { candles5m: Candle[], candles1m: Candle[] }>,
        initialBalance: number,
        startDay?: number,
        endDay?: number,
        slippageBps?: number
    ): Promise<BacktestResult> {

        const portfolio = new PortfolioManager(initialBalance);
        const executionEngine = new ExecutionEngine(
            this.riskEngine,
            portfolio,
            this.tradeRepo
        );
        const effectiveSlippageBps = slippageBps ?? 0.5;
        executionEngine.setSlippage(effectiveSlippageBps / 10000);

        let minTime = Number.MAX_SAFE_INTEGER;
        let maxTime = 0;

        for (const symbol of symbols) {
            const data = dataMap.get(symbol)!;
            if (data.candles1m.length > 0) {
                minTime = Math.min(minTime, data.candles1m[0].timestamp);
                maxTime = Math.max(maxTime, data.candles1m[data.candles1m.length - 1].timestamp);
            }
        }

        minTime = Math.ceil(minTime / 60000) * 60000;

        let simulationStartTime = minTime + (200 * 5 * 60 * 1000);
        let simulationEndTime = maxTime;

        if (startDay !== undefined) {
            const offsetStart = minTime + (startDay * 24 * 60 * 60 * 1000);
            simulationStartTime = Math.max(simulationStartTime, offsetStart);
        }

        if (endDay !== undefined) {
            const offsetEnd = minTime + (endDay * 24 * 60 * 60 * 1000);
            simulationEndTime = Math.min(simulationEndTime, offsetEnd);
        }

        const minTimeStr = new Date(minTime).toISOString().replace('T', ' ').substring(0, 19);
        const maxTimeStr = new Date(maxTime).toISOString().replace('T', ' ').substring(0, 19);
        const simStartTimeStr = new Date(simulationStartTime).toISOString().replace('T', ' ').substring(0, 19);
        const simEndTimeStr = new Date(simulationEndTime).toISOString().replace('T', ' ').substring(0, 19);

        this.logger.info(`Full Data Range: ${minTimeStr} - ${maxTimeStr}`);
        this.logger.info(`Backtest Period: ${simStartTimeStr} - ${simEndTimeStr}`);
        this.logger.info(`Backtest Slippage: ${effectiveSlippageBps.toFixed(2)} bps`);

        let lastLoggedPercent = 0;
        const totalDuration = simulationEndTime - simulationStartTime;

        const cursors = new Map<string, { idx5m: number, idx1m: number }>();
        for (const sym of symbols) cursors.set(sym, { idx5m: 0, idx1m: 0 });

        for (let currentTime = simulationStartTime; currentTime <= simulationEndTime; currentTime += 60 * 1000) {
            const progress = Math.floor(((currentTime - simulationStartTime) / totalDuration) * 100);
            if (progress > lastLoggedPercent && progress % 10 === 0) {
                this.logger.info(`Simulation: ${progress}%`);
                lastLoggedPercent = progress;
            }

            portfolio.resetDailyStats(currentTime);

            for (const symbol of symbols) {
                const data = dataMap.get(symbol)!;
                const cursor = cursors.get(symbol)!;

                while (cursor.idx1m < data.candles1m.length - 1 && data.candles1m[cursor.idx1m].timestamp < currentTime) {
                    cursor.idx1m++;
                }
                const current1m = data.candles1m[cursor.idx1m];

                while (cursor.idx5m < data.candles5m.length - 1 && data.candles5m[cursor.idx5m + 1].timestamp <= currentTime) {
                    cursor.idx5m++;
                }
                const current5mIdx = cursor.idx5m;
                const candle5m = data.candles5m[current5mIdx];

                if (!current1m || current1m.timestamp !== currentTime) continue;

                let valid5mEnd = current5mIdx;
                if (candle5m.timestamp + 5 * 60 * 1000 > currentTime) {
                    valid5mEnd = current5mIdx - 1;
                }

                if (valid5mEnd < 250) continue;

                let valid1mEnd = cursor.idx1m - 1;

                if (valid1mEnd < 50) continue;

                const startBuf = Math.max(0, valid5mEnd - 300);
                const relevant5m = data.candles5m.slice(startBuf, valid5mEnd + 1);
                const closed1m = data.candles1m[valid1mEnd];

                if (!closed1m) continue;

                // ═══════════════════════════════════════════
                // ЕДИНЫЙ ЦИКЛ
                // ═══════════════════════════════════════════

                await executionEngine.onBarClose(closed1m);

                const signal = this.strategy.analyze(symbol, relevant5m);

                if (signal) {
                    await executionEngine.placeOrder(signal);
                }

                await executionEngine.onBarOpen(current1m);
            }

            const markedEquity = portfolio.getBalance() + executionEngine.getUnrealizedPnl();
            portfolio.recordEquity(currentTime, markedEquity);
        }

        await executionEngine.closeAllOpenPositions(simulationEndTime, 'End of Backtest');
        portfolio.recordEquity(simulationEndTime, portfolio.getBalance());

        return this.calculateStats(symbols, initialBalance, portfolio);
    }

    private async calculateStats(
        symbols: string[],
        initialBalance: number,
        portfolio: PortfolioManager
    ): Promise<BacktestResult> {
        const finalBalance = portfolio.getBalance();

        const directionStats = {
            long: this.createDirectionStats(),
            short: this.createDirectionStats()
        };
        const monthlyStatsMap = new Map<string, MonthlyTradeStats>();
        const symbolStatsMap = new Map<string, SymbolTradeStats>();

        let totalStats = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            grossProfit: 0,
            grossLoss: 0
        };

        for (const symbol of symbols) {
            const history = await this.tradeRepo.getTradeHistory(symbol, 100000);
            for (const trade of history) {
                if (trade.status === 'CLOSED' && trade.exitPrice) {
                    totalStats.totalTrades++;

                    const rawPnl = trade.pnl || 0;
                    const directionKey = trade.direction === 'LONG' ? 'long' : 'short';
                    const directionStat = directionStats[directionKey];
                    directionStat.totalTrades++;
                    directionStat.totalPnl += rawPnl;

                    let symbolStats = symbolStatsMap.get(symbol);
                    if (!symbolStats) {
                        symbolStats = {
                            symbol,
                            totalTrades: 0,
                            winningTrades: 0,
                            losingTrades: 0,
                            totalPnl: 0
                        };
                        symbolStatsMap.set(symbol, symbolStats);
                    }

                    symbolStats.totalTrades++;
                    symbolStats.totalPnl += rawPnl;

                    const monthKey = this.formatMonthKey(trade.exitTime ?? trade.entryTime);
                    let monthStats = monthlyStatsMap.get(monthKey);
                    if (!monthStats) {
                        monthStats = {
                            month: monthKey,
                            totalTrades: 0,
                            winningTrades: 0,
                            losingTrades: 0,
                            totalPnl: 0
                        };
                        monthlyStatsMap.set(monthKey, monthStats);
                    }

                    monthStats.totalTrades++;
                    monthStats.totalPnl += rawPnl;

                    if (rawPnl > 0) {
                        totalStats.winningTrades++;
                        totalStats.grossProfit += rawPnl;
                        directionStat.winningTrades++;
                        symbolStats.winningTrades++;
                        monthStats.winningTrades++;
                    } else {
                        totalStats.losingTrades++;
                        totalStats.grossLoss += Math.abs(rawPnl);
                        directionStat.losingTrades++;
                        symbolStats.losingTrades++;
                        monthStats.losingTrades++;
                    }
                }
            }
        }

        // Total PnL = change in balance (already includes fees)
        const totalPnl = finalBalance - initialBalance;

        // Profit factor based on raw PnL
        const pf = totalStats.grossLoss > 0
            ? totalStats.grossProfit / totalStats.grossLoss
            : (totalStats.grossProfit > 0 ? 999 : 0);

        const wr = totalStats.totalTrades > 0
            ? (totalStats.winningTrades / totalStats.totalTrades) * 100
            : 0;

        const monthlyStats = Array.from(monthlyStatsMap.values())
            .sort((a, b) => a.month.localeCompare(b.month));
        const symbolStats = Array.from(symbolStatsMap.values())
            .sort((a, b) => {
                if (b.totalPnl !== a.totalPnl) return b.totalPnl - a.totalPnl;
                return a.symbol.localeCompare(b.symbol);
            });

        return {
            totalTrades: totalStats.totalTrades,
            winningTrades: totalStats.winningTrades,
            losingTrades: totalStats.losingTrades,
            winRate: wr,
            totalPnl,
            finalBalance,
            maxDrawdown: portfolio.getMaxDrawdown() * 100, // Convert to percentage
            profitFactor: pf,
            totalFees: initialBalance - finalBalance + (totalStats.grossProfit - totalStats.grossLoss),
            directionStats,
            monthlyStats,
            symbolStats
        };
    }

    private getEmptyResult(balance: number): BacktestResult {
        return {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            winRate: 0,
            totalPnl: 0,
            finalBalance: balance,
            maxDrawdown: 0,
            directionStats: {
                long: this.createDirectionStats(),
                short: this.createDirectionStats()
            },
            monthlyStats: [],
            symbolStats: []
        };
    }

    private createDirectionStats(): DirectionTradeStats {
        return {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalPnl: 0
        };
    }

    private formatMonthKey(timestamp: number): string {
        const date = new Date(timestamp);
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        return `${date.getUTCFullYear()}-${month}`;
    }
}
