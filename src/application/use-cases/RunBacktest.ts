import { injectable, inject } from 'inversify';
import { RangeBreakPullbackStrategy } from '../strategies/RangeBreakPullbackStrategy';
import { IExchange } from '../../domain/interfaces/IExchange';
import { CandleRepository } from '../../infrastructure/database/repositories/CandleRepository';
import { TradeRepository } from '../../infrastructure/database/repositories/TradeRepository';
import { Candle } from '../../domain/entities/Candle';
import { Logger } from '../../shared/logger/Logger';
import { TYPES } from '../../config/inversify.config';

export interface BacktestConfig {
    symbol: string;
    startDate: Date;
    endDate: Date;
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
        @inject(TYPES.IExchange) private readonly exchange: IExchange,
        private readonly candleRepo: CandleRepository,
        private readonly tradeRepo: TradeRepository
    ) {}

    async execute(config: BacktestConfig): Promise<BacktestResult> {
        this.logger.info('Starting backtest', config);

        const { symbol, startDate, endDate } = config;
        const startTime = startDate.getTime();
        const endTime = endDate.getTime();

        // Load or fetch candles
        const candles5m = await this.loadCandles(symbol, '5m', startTime, endTime);
        const candles1m = await this.loadCandles(symbol, '1m', startTime, endTime);

        this.logger.info(`Loaded ${candles5m.length} 5m candles, ${candles1m.length} 1m candles`);

        // Run backtest simulation
        const result = await this.runSimulation(symbol, candles5m, candles1m);

        this.logger.info('Backtest complete', result);

        return result;
    }

    private async loadCandles(
        symbol: string,
        timeframe: string,
        startTime: number,
        endTime: number
    ): Promise<Candle[]> {
        // Try to load from database first
        const dbCandles = await this.candleRepo.getCandles(symbol, timeframe, startTime, endTime);

        if (dbCandles.length > 0) {
            this.logger.info(`Loaded ${dbCandles.length} ${timeframe} candles from database`);
            return dbCandles;
        }

        // If not in DB, fetch from exchange API
        this.logger.info(`Fetching ${timeframe} candles from exchange API...`);
        const apiCandles = await this.exchange.getCandles(symbol, timeframe, 1000);

        // Filter by date range
        const filteredCandles = apiCandles.filter(
            c => c.timestamp >= startTime && c.timestamp <= endTime
        );

        // Save to database for future use
        await this.candleRepo.saveCandles(filteredCandles);
        this.logger.info(`Saved ${filteredCandles.length} ${timeframe} candles to database`);

        return filteredCandles;
    }

    private async runSimulation(
        symbol: string,
        candles5m: Candle[],
        candles1m: Candle[]
    ): Promise<BacktestResult> {
        let currentIndex5m = 70; // Need at least 70 candles for indicators
        let currentIndex1m = 30;

        while (currentIndex5m < candles5m.length) {
            const current5m = candles5m.slice(0, currentIndex5m);
            const current1m = candles1m.slice(0, currentIndex1m);

            // Process tick
            await this.strategy.processTick(symbol, current5m, current1m);

            // Move forward
            currentIndex5m++;
            currentIndex1m += 5; // 5m = 5 x 1m candles

            if (currentIndex1m >= candles1m.length) break;
        }

        // Calculate results
        const stats = await this.tradeRepo.getTradeStats(symbol);

        return {
            totalTrades: stats.total,
            winningTrades: stats.wins,
            losingTrades: stats.losses,
            winRate: stats.winRate,
            totalPnl: stats.totalPnl,
            finalBalance: 10000 + stats.totalPnl, // TODO: track actual balance
            maxDrawdown: 0, // TODO: calculate
            profitFactor: stats.wins > 0 && stats.losses > 0 
                ? stats.wins / stats.losses 
                : undefined
        };
    }
}
