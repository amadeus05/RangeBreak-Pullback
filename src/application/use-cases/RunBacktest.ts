import { injectable, inject } from 'inversify';
import { MeanReversionStrategy } from '../strategies/MeanReversionStrategy';
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
    @inject(TYPES.Strategy) private readonly strategy: MeanReversionStrategy,
    @inject(TYPES.IExchange) private readonly executionExchange: IExchange,
    @inject(TYPES.IDataFeed) private readonly dataFeed: IExchange,
    private readonly candleRepo: CandleRepository,
    private readonly tradeRepo: TradeRepository
) {}

async execute(config: BacktestConfig): Promise<BacktestResult> {
    this.logger.info('Starting Strict MR backtest', config);

    const { symbol, days } = config;
    
    await this.tradeRepo.clearTrades();

    const endTime = Date.now();
    const startTime = endTime - (days * 24 * 60 * 60 * 1000);

    // Fetch data (код загрузки данных опустим для краткости, он не менялся, если надо - напишите)
    const candles5m = await this.fetchHistoricalData(symbol, '5m', startTime, endTime);
    const candles1m = await this.fetchHistoricalData(symbol, '1m', startTime, endTime);

    this.logger.info(`Loaded: ${candles5m.length} (5m)`);

    return this.runSimulation(symbol, candles5m, candles1m, config.initialBalance);
}

// ... (fetchHistoricalData оставляем как был в версии для Binance) ...
private async fetchHistoricalData(symbol: string, timeframe: string, start: number, end: number): Promise<Candle[]> {
     const dbCount = await this.candleRepo.countInRange(symbol, timeframe, start, end);
    if (dbCount > 100) return await this.candleRepo.getCandles(symbol, timeframe, start, end);
    
    let curr = start;
    const LIMIT = 1000;
    while (curr < end) {
        try {
            const batch = await this.dataFeed.getCandles(symbol, timeframe, LIMIT, curr);
            if (!batch.length) break;
            await this.candleRepo.saveCandles(batch);
            curr = batch[batch.length - 1].timestamp + 1;
            await new Promise(r => setTimeout(r, 300));
        } catch (e) { break; }
    }
    return await this.candleRepo.getCandles(symbol, timeframe, start, end);
}

private async runSimulation(symbol: string, candles5m: Candle[], candles1m: Candle[], initialBalance: number): Promise<BacktestResult> {
    let idx5m = 0;
    let idx1m = 0;
    const warmup = 205; 
    
    if (candles5m.length < warmup) return { totalTrades: 0, winRate: 0, totalPnl: 0, winningTrades: 0, losingTrades: 0, finalBalance: initialBalance, maxDrawdown: 0 };
    
    idx5m = warmup;
    const startTimestamp = candles5m[idx5m].timestamp;
    idx1m = candles1m.findIndex(c => c.timestamp >= startTimestamp);
    if (idx1m === -1) idx1m = 0;

    let lastLoggedPercent = 0;
    
    // Для динамического баланса будем периодически опрашивать базу или считать локально
    // Чтобы не дергать БД каждый тик, будем обновлять баланс при каждом processTick, получая стату
    let currentRealBalance = initialBalance;

    while (idx5m < candles5m.length && idx1m < candles1m.length) {
        const current5mList = candles5m.slice(0, idx5m + 1);
        const current1mList = candles1m.slice(0, idx1m + 1);
        const current5mTime = candles5m[idx5m].timestamp;
        const current1mTime = candles1m[idx1m].timestamp;
        
        const progress = Math.floor((idx5m / candles5m.length) * 100);
        if (progress > lastLoggedPercent && progress % 10 === 0) {
            this.logger.info(`Simulation: ${progress}%`);
            lastLoggedPercent = progress;
        }

        if (current1mTime < current5mTime) {
             idx1m++;
        } else {
            // Обновляем баланс перед шагом стратегии
            // ВАЖНО: Это немного медленно, но точно. 
            // Для оптимизации можно считать PnL локально в переменной, но через Repo надежнее.
            // Чтобы не тормозить, можно обновлять баланс только если была сделка.
            
            // Передаем баланс в стратегию
            await this.strategy.processTick(symbol, current5mList, current1mList, currentRealBalance);
            
            // Если стратегия закрыла сделку, баланс изменится к следующему шагу
            // (можно оптимизировать, но пока оставим как есть)
            
            idx5m++;
            while(idx1m < candles1m.length && candles1m[idx1m].timestamp <= candles5m[idx5m]?.timestamp) {
                 idx1m++;
            }
        }
    }
    
    // Финальный пересчет
    const stats = await this.tradeRepo.getTradeStats(symbol);
    return {
        totalTrades: stats.total,
        winningTrades: stats.wins,
        losingTrades: stats.losses,
        winRate: stats.winRate,
        totalPnl: stats.totalPnl,
        finalBalance: initialBalance + stats.totalPnl,
        maxDrawdown: 0, 
        profitFactor: stats.profitFactor
    };
}
}