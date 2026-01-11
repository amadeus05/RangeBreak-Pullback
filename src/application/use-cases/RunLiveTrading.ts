import { injectable, inject } from "inversify";
import { MeanReversionStrategy } from "../strategies/MeanReversionStrategy"; // Updated Import
import { IExchange } from "../../domain/interfaces/IExchange";
import { Candle } from "../../domain/entities/Candle";
import { Logger } from "../../shared/logger/Logger";
import { TYPES } from "../../config/types";
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
    // Updated Strategy
    @inject(TYPES.Strategy) private readonly strategy: MeanReversionStrategy,
    @inject(TYPES.IExchange) private readonly exchange: IExchange
  ) {}

  async start(config: LiveTradingConfig): Promise<void> {
    this.logger.info("Starting LIVE MR Trading", config);
    this.isRunning = true;

    await this.loadInitialData(config.symbol);

    while (this.isRunning) {
      try {
        await this.processTick(config.symbol);
        await this.sleep(config.tickInterval);
      } catch (error) {
        this.logger.error("Error in tick loop", error);
      }
    }
  }

  stop(): void {
    this.logger.info("Stopping live trading");
    this.isRunning = false;
  }

  private async loadInitialData(symbol: string): Promise<void> {
    this.logger.info("Loading initial candle data");
    this.candles5m = await this.exchange.getCandles(symbol, "5m", 300);
    this.candles1m = await this.exchange.getCandles(symbol, "1m", 300);
    this.logger.info(`Loaded ${this.candles5m.length} 5m candles`);
  }

  private async processTick(symbol: string): Promise<void> {
    // In a real implementation of this specific strategy,
    // we would need a WebSocket stream for AggTrades to calculate exact Delta.
    // For this architecture using polling (getCandles), we rely on the
    // exchange adapter mapping TakerBuyVolume to Candle.delta.

    const latest5m = await this.exchange.getCandles(symbol, "5m", 2); // Get last 2 to ensure closure
    const latest1m = await this.exchange.getCandles(symbol, "1m", 2);

    if (latest5m.length > 0) {
      // Logic to merge/update buffers
      const newCandle = latest5m[latest5m.length - 1];
      this.updateCandleBuffer(this.candles5m, newCandle, 500);
    }

    if (latest1m.length > 0) {
      const newCandle = latest1m[latest1m.length - 1];
      this.updateCandleBuffer(this.candles1m, newCandle, 500);
    }

    const currentBalance = 500; // Mock balance or fetch from exchange

    await this.strategy.processTick(
      symbol,
      this.candles5m,
      this.candles1m,
      currentBalance
    );
  }

  private updateCandleBuffer(
    buffer: Candle[],
    newCandle: Candle,
    maxSize: number
  ): void {
    const lastCandle = buffer[buffer.length - 1];
    if (lastCandle && lastCandle.timestamp === newCandle.timestamp) {
      buffer[buffer.length - 1] = newCandle; // Update current
    } else {
      buffer.push(newCandle); // Push new
      if (buffer.length > maxSize) buffer.shift();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
