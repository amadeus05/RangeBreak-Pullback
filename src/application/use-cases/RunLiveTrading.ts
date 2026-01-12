import { injectable, inject } from 'inversify';
import { RangeBreakPullbackStrategy } from '../strategies/RangeBreakPullbackStrategy';
import { ExecutionEngine } from '../services/execution/ExecutionEngine';
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
        @inject(TYPES.IExchange) private readonly exchange: IExchange,
        // Inject ExecutionEngine to actually handle the orders and positions
        @inject(ExecutionEngine) private readonly executionEngine: ExecutionEngine
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
                // Optional: add a small delay on error to prevent infinite fast-crashing
                await this.sleep(1000);
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
        // 1. Fetch latest data
        const latest5m = await this.exchange.getCandles(symbol, '5m', 1);
        const latest1m = await this.exchange.getCandles(symbol, '1m', 1);

        if (latest5m.length > 0) {
            this.updateCandleBuffer(this.candles5m, latest5m[0], 300);
        }

        if (latest1m.length > 0) {
            this.updateCandleBuffer(this.candles1m, latest1m[0], 300);
        }

        const current1m = this.candles1m[this.candles1m.length - 1];
        if (!current1m) return;

        // 2. Update Execution Engine (Checks SL/TP and pending orders)
        await this.executionEngine.onMarketData(current1m);

        // 3. Generate Signal from Strategy
        // The method is generateSignal, not processTick
        const signal = this.strategy.generateSignal(
            symbol, 
            this.candles5m, 
            this.candles1m
        );

        // 4. If strategy produced a signal, place the order
        if (signal) {
            this.logger.info(`[STRATEGY] New signal generated for ${symbol}: ${signal.direction}`);
            await this.executionEngine.placeOrder(signal);
        }
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