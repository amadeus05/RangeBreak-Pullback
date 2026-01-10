import { Candle } from '../entities/Candle';
import { MarketRange } from '../value-objects/MarketRange';

export interface IRangeDetector {
    detectRange(candles: Candle[]): MarketRange | null;
    isRangeValid(range: MarketRange, atr: number): boolean;
}