import { injectable, inject } from 'inversify';
import { IExchange } from '../../domain/interfaces/IExchange';
import { CandleRepository } from '../../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';
import { Candle } from '../../domain/entities/Candle';
import { Logger } from '../../shared/logger/Logger';
import { TYPES } from '../../config/types';
import { RangeBreakPullbackStrategy } from '../strategies/RangeBreakPullbackStrategy';
import { ExecutionEngine } from '../services/execution/ExecutionEngine';
import { PortfolioManager } from '../services/portfolio/PortfolioManager';
import { IRiskEngine } from '../../domain/interfaces/IRiskEngine';

export interface BacktestConfig {
    symbols: string[];
    days: number;
    initialBalance: number;
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
}

@injectable()
export class RunBacktest {
    private logger = Logger.getInstance();
    private readonly MAKER_FEE = 0.0002;
    private readonly TAKER_FEE = 0.0005;

    constructor(
        @inject(TYPES.Strategy) private readonly strategy: RangeBreakPullbackStrategy,
        @inject(TYPES.IDataFeed) private readonly dataFeed: IExchange,
        @inject(TYPES.IRiskEngine) private readonly riskEngine: IRiskEngine,
        private readonly candleRepo: CandleRepository,
        private readonly tradeRepo: TradeRepository
    ) {}

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

        return this.runSynchronizedSimulation(validSymbols, dataMap, config.initialBalance);
    }

    private async fetchHistoricalData(
        symbol: string,
        timeframe: string,
        start: number,
        end: number
    ): Promise<Candle[]> {
        // Проверяем кеш - есть ли уже все данные
        const cachedCount = await this.candleRepo.countInRange(symbol, timeframe, start, end);
        const expectedCount = Math.floor((end - start) / this.getTimeframeMs(timeframe));
        
        // Если есть >= 95% данных, считаем что достаточно
        if (cachedCount >= expectedCount * 0.95) {
            this.logger.info(`[CACHE] ${symbol} ${timeframe}: Found ${cachedCount} candles in DB (expected ~${expectedCount})`);
            return await this.candleRepo.getCandles(symbol, timeframe, start, end);
        }

        // Определяем откуда грузить
        const lastCandle = await this.candleRepo.getLastCandle(symbol, timeframe);
        let downloadStart = start;
        
        if (lastCandle && lastCandle.timestamp > start) {
            downloadStart = lastCandle.timestamp + this.getTimeframeMs(timeframe);
            this.logger.info(`[CACHE] ${symbol} ${timeframe}: Resuming from ${new Date(downloadStart).toISOString()}`);
        } else {
            this.logger.info(`[DOWNLOAD] ${symbol} ${timeframe}: Starting fresh download...`);
        }

        // Скачиваем недостающие данные
        let curr = downloadStart;
        const LIMIT = 1000;
        const MAX_RETRIES = 3;
        const TIMEOUT_MS = 10000; // 10 секунд на запрос
        let loopCount = 0;
        let totalDownloaded = 0;

        while (curr < end && loopCount < 500) {
            let retries = 0;
            let success = false;

            while (retries < MAX_RETRIES && !success) {
                try {
                    // Timeout wrapper
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
        initialBalance: number
    ): Promise<BacktestResult> {
        // Создаем Portfolio и Execution Engine
        const portfolio = new PortfolioManager(initialBalance);
        const executionEngine = new ExecutionEngine(
            this.riskEngine, 
            portfolio,
            this.tradeRepo
        );

        // Timeline
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
        const simulationStartTime = minTime + (200 * 5 * 60 * 1000);

        this.logger.info(`Data Range: ${new Date(minTime).toISOString()} - ${new Date(maxTime).toISOString()}`);
        this.logger.info(`Simulation Start (after warmup): ${new Date(simulationStartTime).toISOString()}`);

        let lastLoggedPercent = 0;
        const totalDuration = maxTime - simulationStartTime;

        const cursors = new Map<string, { idx5m: number, idx1m: number }>();
        for (const sym of symbols) cursors.set(sym, { idx5m: 0, idx1m: 0 });

        // MAIN LOOP
        for (let currentTime = simulationStartTime; currentTime <= maxTime; currentTime += 60 * 1000) {
            const progress = Math.floor(((currentTime - simulationStartTime) / totalDuration) * 100);
            if (progress > lastLoggedPercent && progress % 10 === 0) {
                this.logger.info(`Simulation: ${progress}%`);
                lastLoggedPercent = progress;
            }

            portfolio.resetDailyStats(currentTime);

            for (const symbol of symbols) {
                const data = dataMap.get(symbol)!;
                const cursor = cursors.get(symbol)!;

                // Advance cursors
                while (cursor.idx1m < data.candles1m.length - 1 && data.candles1m[cursor.idx1m].timestamp < currentTime) {
                    cursor.idx1m++;
                }
                const candle1m = data.candles1m[cursor.idx1m];

                while (cursor.idx5m < data.candles5m.length - 1 && data.candles5m[cursor.idx5m + 1].timestamp <= currentTime) {
                    cursor.idx5m++;
                }
                const current5mIdx = cursor.idx5m;
                const candle5m = data.candles5m[current5mIdx];

                // Validation
                if (!candle1m || candle1m.timestamp !== currentTime) continue;

                // ═══════════════════════════════════════════
                // FIX LOOKAHEAD BIAS: Передаем только ЗАКРЫТЫЕ свечи
                // ═══════════════════════════════════════════
                
                // 5m: Если текущая 5m свеча еще не закрылась, берем предыдущую
                let valid5mEnd = current5mIdx;
                if (candle5m.timestamp + 5 * 60 * 1000 > currentTime) {
                    valid5mEnd = current5mIdx - 1;
                }

                if (valid5mEnd < 250) continue;

                // 1m: Текущая свеча (cursor.idx1m) еще НЕ закрыта!
                // В реальности мы не знаем её close/high/low до конца минуты.
                // Используем только свечи ДО текущей (idx1m - 1)
                let valid1mEnd = cursor.idx1m - 1;
                
                if (valid1mEnd < 50) continue; // Нужен минимум буфер

                // Prepare data
                const startBuf = Math.max(0, valid5mEnd - 300);
                const relevant5m = data.candles5m.slice(startBuf, valid5mEnd + 1);
                const relevant1m = data.candles1m.slice(Math.max(0, valid1mEnd - 50), valid1mEnd + 1);

                // ═══════════════════════════════════════════
                // ЕДИНЫЙ ЦИКЛ (как в примере)
                // ═══════════════════════════════════════════

                // 1. Execution Engine обрабатывает рынок
                await executionEngine.onMarketData(candle1m);

                // 2. Strategy генерирует сигнал
                const signal = this.strategy.generateSignal(symbol, relevant5m, relevant1m);

                // 3. Если есть сигнал → отправляем в Execution
                if (signal) {
                    await executionEngine.placeOrder(signal);
                }
            }
        }

        return this.calculateStats(symbols, initialBalance, portfolio.getBalance());
    }

    private async calculateStats(
        symbols: string[],
        initialBalance: number,
        finalBalance: number
    ): Promise<BacktestResult> {
        let totalStats = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalPnl: 0,
            totalFees: 0,
            grossProfit: 0,
            grossLoss: 0
        };

        for (const symbol of symbols) {
            const history = await this.tradeRepo.getTradeHistory(symbol, 100000);
            for (const trade of history) {
                if (trade.status === 'CLOSED' && trade.exitPrice) {
                    totalStats.totalTrades++;
                    const entryVol = trade.entryPrice * trade.size;
                    const exitVol = trade.exitPrice * trade.size;
                    const entryFee = entryVol * this.TAKER_FEE;
                    let exitFee = trade.exitReason?.includes('Stop')
                        ? exitVol * this.TAKER_FEE
                        : exitVol * this.MAKER_FEE;

                    const tradeFee = entryFee + exitFee;
                    totalStats.totalFees += tradeFee;
                    const netPnl = (trade.pnl || 0) - tradeFee;
                    totalStats.totalPnl += netPnl;

                    if (netPnl > 0) {
                        totalStats.winningTrades++;
                        totalStats.grossProfit += netPnl;
                    } else {
                        totalStats.losingTrades++;
                        totalStats.grossLoss += Math.abs(netPnl);
                    }
                }
            }
        }

        const pf = totalStats.grossLoss > 0
            ? totalStats.grossProfit / totalStats.grossLoss
            : (totalStats.grossProfit > 0 ? 999 : 0);
        const wr = totalStats.totalTrades > 0
            ? (totalStats.winningTrades / totalStats.totalTrades) * 100
            : 0;

        return {
            totalTrades: totalStats.totalTrades,
            winningTrades: totalStats.winningTrades,
            losingTrades: totalStats.losingTrades,
            winRate: wr,
            totalPnl: totalStats.totalPnl,
            finalBalance,
            maxDrawdown: 0,
            profitFactor: pf,
            totalFees: totalStats.totalFees
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
            maxDrawdown: 0
        };
    }
}