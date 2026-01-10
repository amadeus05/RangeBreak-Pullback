import { injectable, inject } from 'inversify';
import { RangeBreakPullbackStrategy } from '../strategies/RangeBreakPullbackStrategy';
import { IExchange } from '../../domain/interfaces/IExchange';
import { CandleRepository } from '../../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';
import { Candle } from '../../domain/entities/Candle';
import { Logger } from '../../shared/logger/Logger';
import { TYPES } from '../../config/types';

export interface BacktestConfig {
    symbol: string;
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
}

@injectable()
export class RunBacktest {
    private logger = Logger.getInstance();

    constructor(
        @inject(TYPES.Strategy) private readonly strategy: RangeBreakPullbackStrategy,
        @inject(TYPES.IExchange) private readonly executionExchange: IExchange,
        @inject(TYPES.IDataFeed) private readonly dataFeed: IExchange,
        private readonly candleRepo: CandleRepository,
        private readonly tradeRepo: TradeRepository
    ) {}

    async execute(config: BacktestConfig): Promise<BacktestResult> {
        this.logger.info('Starting backtest setup', config);

        const { symbol, days } = config;
        const endTime = Date.now();
        const startTime = endTime - (days * 24 * 60 * 60 * 1000);

        this.logger.info(`Target period: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

        await this.ensureDataAvailable(symbol, '5m', startTime, endTime);
        await this.ensureDataAvailable(symbol, '1m', startTime, endTime);

        this.logger.info('Loading verified data from DB...');
        const candles5m = await this.candleRepo.getCandles(symbol, '5m', startTime, endTime);
        const candles1m = await this.candleRepo.getCandles(symbol, '1m', startTime, endTime);

        this.logger.info(`Loaded for Simulation: ${candles5m.length} (5m) and ${candles1m.length} (1m) candles`);

        if (candles5m.length === 0 || candles1m.length === 0) {
            throw new Error('Failed to load data for backtest even after synchronization attempt');
        }

        return this.runSimulation(symbol, candles5m, candles1m, config.initialBalance);
    }

    private async ensureDataAvailable(
        symbol: string,
        timeframe: string,
        requiredStart: number,
        requiredEnd: number
    ): Promise<void> {
        const dbRange = await this.candleRepo.getDataRange(symbol, timeframe);
        
        // Упрощенная логика: если есть хоть малейшая нехватка или разрыв - качаем всё (для надежности)
        // В продакшене тут можно сделать умную докачку только недостающих кусков.
        let needsDownload = true;
        
        if (dbRange) {
            const hasStart = dbRange.min <= requiredStart;
            // Допускаем задержку в 1 час для "свежести" данных
            const hasEnd = dbRange.max >= requiredEnd - 1000 * 60 * 60; 
            
            if (hasStart && hasEnd) {
                this.logger.info(`Data for ${timeframe} exists in DB and covers range.`);
                needsDownload = false;
            }
        }

        if (needsDownload) {
            await this.downloadHistory(symbol, timeframe, requiredStart, requiredEnd);
        }
    }

    private async downloadHistory(
        symbol: string,
        timeframe: string,
        startTime: number,
        endTime: number
    ): Promise<void> {
        this.logger.info(`Starting download for ${symbol} ${timeframe}. Optimized mode.`);
        
        const timeframeMs = this.getTimeframeMs(timeframe);
        let currentCursor = endTime;
        
        // ОПТИМИЗАЦИЯ 1: Лимит 1000 (максимум для Bybit)
        const BATCH_LIMIT = 1000; 
        
        let prevBatchOldestTimestamp: number | null = null; 

        while (currentCursor > startTime) {
            try {
                const candles = await this.dataFeed.getCandles(symbol, timeframe, BATCH_LIMIT, currentCursor);

                if (candles.length === 0) {
                    this.logger.warn('Received empty batch from API. Stopping download.');
                    break;
                }

                const batchOldest = candles[0].timestamp;
                const batchNewest = candles[candles.length - 1].timestamp;

                this.validateBatchContinuity(candles, timeframeMs);

                if (prevBatchOldestTimestamp !== null) {
                    const expectedTimestamp = prevBatchOldestTimestamp - timeframeMs;
                    if (batchNewest !== expectedTimestamp) {
                        const gapSize = (prevBatchOldestTimestamp - batchNewest) / timeframeMs;
                        // Логируем как Debug, чтобы не спамить в консоль, если гэпы частые
                        this.logger.debug(`Potential gap detected: missing ~${gapSize - 1} candles.`);
                    }
                }

                await this.candleRepo.saveCandles(candles);
                
                this.logger.info(`Saved ${candles.length} candles. cursor: ${new Date(batchOldest).toISOString()}`);

                prevBatchOldestTimestamp = batchOldest;
                currentCursor = batchOldest - 1; 

                if (candles.length < BATCH_LIMIT && currentCursor > startTime) {
                    this.logger.warn('Exchange returned fewer candles than limit. End of available history?');
                    break;
                }

                // ОПТИМИЗАЦИЯ 2: Уменьшаем задержку. 20ms достаточно для Bybit.
                await this.sleep(20);

            } catch (error) {
                this.logger.error('Error fetching history batch', error);
                throw error;
            }
        }
        
        this.logger.info(`Download complete for ${timeframe}`);
    }

    private validateBatchContinuity(candles: Candle[], intervalMs: number): void {
        for (let i = 0; i < candles.length - 1; i++) {
            const current = candles[i];
            const next = candles[i + 1];
            
            // Проверяем разницу между соседями
            const diff = next.timestamp - current.timestamp;
            
            if (diff !== intervalMs) {
                // Если разница не равна интервалу (с допуском 1мс на всякий случай)
                if (Math.abs(diff - intervalMs) > 1) {
                    const missingCount = (diff / intervalMs) - 1;
                    this.logger.warn(`GAP INSIDE BATCH: ${new Date(current.timestamp).toISOString()} -> ${new Date(next.timestamp).toISOString()}. Missing ${missingCount} candles.`);
                }
            }
        }
    }

    private getTimeframeMs(tf: string): number {
        const value = parseInt(tf);
        if (tf.includes('m')) return value * 60 * 1000;
        if (tf.includes('h')) return value * 60 * 60 * 1000;
        if (tf.includes('d')) return value * 24 * 60 * 60 * 1000;
        
        // Если пришло "5" или "1" (как для Bybit API) считаем это минутами
        return value * 60 * 1000;
    }

    private async runSimulation(
        symbol: string,
        candles5m: Candle[],
        candles1m: Candle[],
        initialBalance: number
    ): Promise<BacktestResult> {
        let idx5m = 0;
        let idx1m = 0;

        if (candles5m.length < 70) return { totalTrades: 0, winRate: 0, totalPnl: 0, winningTrades: 0, losingTrades: 0, finalBalance: initialBalance, maxDrawdown: 0 };
        idx5m = 70;
        
        const startTimestamp = candles5m[idx5m].timestamp;
        
        idx1m = candles1m.findIndex(c => c.timestamp >= startTimestamp);
        if (idx1m === -1) idx1m = 0;

        while (idx5m < candles5m.length && idx1m < candles1m.length) {
            const current5mList = candles5m.slice(0, idx5m + 1);
            const current1mList = candles1m.slice(0, idx1m + 1);
            
            const current5mTime = candles5m[idx5m].timestamp;
            const current1mTime = candles1m[idx1m].timestamp;

            if (current1mTime < current5mTime) {
                await this.strategy.processTick(symbol, current5mList, current1mList);
                idx1m++;
            } else {
                await this.strategy.processTick(symbol, current5mList, current1mList);
                idx5m++;
                while(idx1m < candles1m.length && candles1m[idx1m].timestamp <= candles5m[idx5m]?.timestamp) {
                     idx1m++;
                }
            }
        }

        const stats = await this.tradeRepo.getTradeStats(symbol);
        
        return {
            totalTrades: stats.total,
            winningTrades: stats.wins,
            losingTrades: stats.losses,
            winRate: stats.winRate,
            totalPnl: stats.totalPnl,
            finalBalance: initialBalance + stats.totalPnl,
            maxDrawdown: 0,
            profitFactor: stats.losses > 0 ? stats.wins / stats.losses : 0
        };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}