import { Candle } from '../entities/Candle';

export class MarketRange {
    constructor(
        public readonly high: number,
        public readonly low: number,
        public readonly timestamp: number,
        public readonly size: number
    ) {}

    static create(candles: Candle[]): MarketRange {
        const high = Math.max(...candles.map(c => c.high));
        const low = Math.min(...candles.map(c => c.low));
        const timestamp = Date.now();
        const size = high - low;
        return new MarketRange(high, low, timestamp, size);
    }
}