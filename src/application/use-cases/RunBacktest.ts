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
        
        await this.tradeRepo.clearTrades();

        const endTime = Date.now();
        const startTime = endTime - (days * 24 * 60 * 60 * 1000);

        this.logger.info(`Target period: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

        // Скачиваем/Проверяем данные с УМНЫМ RESUME
        const candles5m = await this.fetchHistoricalData(symbol, '5m', startTime, endTime);
        const candles1m = await this.fetchHistoricalData(symbol, '1m', startTime, endTime);

        this.logger.info(`Ready for simulation. Loaded: ${candles5m.length} (5m) and ${candles1m.length} (1m)`);

        if (candles5m.length === 0 || candles1m.length === 0) {
            throw new Error('No data found for backtest');
        }

        return this.runSimulation(symbol, candles5m, candles1m, config.initialBalance);
    }

    private async fetchHistoricalData(symbol: string, timeframe: string, start: number, end: number): Promise<Candle[]> {
        // 1. Спрашиваем базу, сколько там свечей в этом диапазоне
        const dbCount = await this.candleRepo.countInRange(symbol, timeframe, start, end);

        // --- HOTFIX: OFFLINE MODE ---
        // Если мы нашли хотя бы 100 свечей, считаем, что данные есть, и не качаем заново.
        // Это спасет от бесконечных загрузок, если окно сдвинулось на 5 минут.
        if (dbCount > 100) {
            this.logger.info(`⚡ FAST START: Found ${dbCount} candles in DB for ${timeframe}. Using existing data.`);
            
            // Загружаем то, что есть, даже если там не хватает последних 5 минут
            return await this.candleRepo.getCandles(symbol, timeframe, start, end);
        }
        // -----------------------------

        this.logger.info(`Data missing (found only ${dbCount}). Starting download for ${timeframe}...`);

        // 2. Если данных совсем нет (или меньше 100), тогда качаем (RESUME логика)
        let curr = start;
        const lastInDb = await this.candleRepo.getLastCandle(symbol, timeframe);
        
        if (lastInDb && lastInDb.timestamp >= start && lastInDb.timestamp < end) {
            this.logger.info(`Resuming ${timeframe} download from ${new Date(lastInDb.timestamp).toISOString()}`);
            curr = lastInDb.timestamp + 1; 
        }

        // 3. Цикл скачивания
        const allNewCandles: Candle[] = [];
        const LIMIT = 1000;

        while (curr < end) {
            try {
                const batch = await this.dataFeed.getCandles(symbol, timeframe, LIMIT, curr);
                
                if (!batch.length) break;

                await this.candleRepo.saveCandles(batch);
                allNewCandles.push(...batch);
                
                const lastTimestamp = batch[batch.length - 1].timestamp;
                const progress = ((lastTimestamp - start) / (end - start)) * 100;
                
                process.stdout.write(`\rDownloading ${timeframe}: ${progress.toFixed(1)}%...`);

                if (lastTimestamp >= end) break;
                curr = lastTimestamp + 1;
                
                await this.sleep(50); // Не бомбим API
            } catch (e) {
                console.error(`\nDownload interrupted: ${e}`);
                break; // Выходим при ошибке, чтобы сохранить то, что скачали
            }
        }
        
        console.log('');
        this.logger.info(`Download finished. Added ${allNewCandles.length} candles.`);
        
        return await this.candleRepo.getCandles(symbol, timeframe, start, end);
    }

    private getTimeframeMs(tf: string): number {
        const value = parseInt(tf);
        if (tf.includes('m')) return value * 60 * 1000;
        if (tf.includes('h')) return value * 60 * 60 * 1000;
        if (tf.includes('d')) return value * 24 * 60 * 60 * 1000;
        return value * 60 * 1000;
    }

    private async runSimulation(symbol: string, candles5m: Candle[], candles1m: Candle[], initialBalance: number): Promise<BacktestResult> {
        let idx5m = 0;
        let idx1m = 0;
        let currentPnl = 0;

        if (candles5m.length < 70) return { totalTrades: 0, winRate: 0, totalPnl: 0, winningTrades: 0, losingTrades: 0, finalBalance: initialBalance, maxDrawdown: 0 };
        idx5m = 70;
        const startTimestamp = candles5m[idx5m].timestamp;
        idx1m = candles1m.findIndex(c => c.timestamp >= startTimestamp);
        if (idx1m === -1) idx1m = 0;

        let lastLoggedPercent = 0;

        while (idx5m < candles5m.length && idx1m < candles1m.length) {
            const current5mList = candles5m.slice(0, idx5m + 1);
            const current1mList = candles1m.slice(0, idx1m + 1);
            const current5mTime = candles5m[idx5m].timestamp;
            const current1mTime = candles1m[idx1m].timestamp;

            const progress = Math.floor((idx5m / candles5m.length) * 100);
            if (progress > lastLoggedPercent && progress % 10 === 0) {
                const date = new Date(current5mTime).toISOString().split('T')[0];
                this.logger.info(`Simulation: ${progress}% (${date})`);
                lastLoggedPercent = progress;
            }

            const currentBalance = initialBalance + currentPnl;

            if (current1mTime < current5mTime) {
                await this.strategy.processTick(symbol, current5mList, current1mList, currentBalance);
                idx1m++;
            } else {
                await this.strategy.processTick(symbol, current5mList, current1mList, currentBalance);
                idx5m++;
                while(idx1m < candles1m.length && candles1m[idx1m].timestamp <= candles5m[idx5m]?.timestamp) {
                     idx1m++;
                }
                if (idx5m % 24 === 0) { 
                    const stats = await this.tradeRepo.getTradeStats(symbol);
                    currentPnl = stats.totalPnl;
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
            profitFactor: stats.profitFactor // Берем из репо
        };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}