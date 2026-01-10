import { injectable } from 'inversify';
import { IRangeDetector } from '../../../domain/interfaces/IRangeDetector';
import { Candle } from '../../../domain/entities/Candle';
import { MarketRange } from '../../../domain/value-objects/MarketRange';

@injectable()
export class RangeDetector implements IRangeDetector {
    private readonly RANGE_WINDOW = 30;

    detectRange(candles: Candle[]): MarketRange | null {
        if (candles.length < this.RANGE_WINDOW) return null;

        const window = candles.slice(-this.RANGE_WINDOW);
        return MarketRange.create(window);
    }

    isRangeValid(range: MarketRange, atr: number): boolean {
        // Range size >= 1.2 * ATR
        // Range size <= 3.5 * ATR
        return range.size >= 1.2 * atr && range.size <= 3.5 * atr;
    }
}