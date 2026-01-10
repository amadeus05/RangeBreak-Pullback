import { injectable, inject } from 'inversify';
import { RangeBreakPullbackStrategy } from '../strategies/RangeBreakPullbackStrategy';
import { IExchange } from '../../domain/interfaces/IExchange';
import { Candle } from '../../domain/entities/Candle';
import { Logger } from '../../shared/logger/Logger';
import { TYPES } from '../../config/types';

export interface LiveTradingConfig {
    symbol: string;
    tickInterval: number;
}

@injectable()
export class RunLiveTrading {
    private logger = Logger.getInstance();
    private isRunning = false;
    private candles5m: Candle[] = [];
    private candles1m: Candle[] = [];

    constructor(
        @inject(TYPES.Strategy) private readonly strategy: RangeBreakPullbackStrategy,
        @inject(TYPES.IExchange) private readonly exchange: IExchange
    ) {}

    async start(config: LiveTradingConfig): Promise<void> {
        this.logger.info('Starting live trading', config);
        this.isRunning = true;

        await this.loadInitialData(config.symbol);

        while (this.isRunning) {
            try {
                await this.processTick(config.symbol);
                await this.sleep(config.tickInterval);
            } catch (error) {
                this.logger.error('Error in tick loop', error);
            }
        }
    }

    stop(): void {
        this.logger.info('Stopping live trading');
        this.isRunning = false;
    }

    private async loadInitialData(symbol: string): Promise<void> {
        this.logger.info('Loading initial candle data');
        this.candles5m = await this.exchange.getCandles(symbol, '5m', 300);
        this.candles1m = await this.exchange.getCandles(symbol, '1m', 300);
        this.logger.info(`Loaded ${this.candles5m.length} 5m and ${this.candles1m.length} 1m candles`);
    }

    private async processTick(symbol: string): Promise<void> {
        const latest5m = await this.exchange.getCandles(symbol, '5m', 1);
        const latest1m = await this.exchange.getCandles(symbol, '1m', 1);

        if (latest5m.length > 0) {
            this.updateCandleBuffer(this.candles5m, latest5m[0], 300);
        }

        if (latest1m.length > 0) {
            this.updateCandleBuffer(this.candles1m, latest1m[0], 300);
        }

        // В будущем: получать реальный баланс через this.exchange.getBalance()
        const currentBalance = 500; 

        // Передаем баланс в стратегию
        await this.strategy.processTick(symbol, this.candles5m, this.candles1m, currentBalance);
    }

    private updateCandleBuffer(buffer: Candle[], newCandle: Candle, maxSize: number): void {
        const lastCandle = buffer[buffer.length - 1];
        
        if (lastCandle && lastCandle.timestamp === newCandle.timestamp) {
            buffer[buffer.length - 1] = newCandle;
        } else {
            buffer.push(newCandle);
            if (buffer.length > maxSize) {
                buffer.shift();
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}