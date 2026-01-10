import { injectable } from 'inversify';
import { IPullbackValidator } from '../../../domain/interfaces/IPullbackValidator';
import { Candle } from '../../../domain/entities/Candle';
import { BreakoutSignal } from '../../../domain/value-objects/BreakoutSignal';
import { MarketRange } from '../../../domain/value-objects/MarketRange';
import { TradeDirection } from '../../../domain/enums/TradeDirection';

@injectable()
export class PullbackValidator implements IPullbackValidator {
    private readonly MAX_PULLBACK_CANDLES = 10;

    isPullbackValid(
        candles1m: Candle[],
        breakout: BreakoutSignal,
        range: MarketRange,
        vwap: number
    ): boolean {
        if (candles1m.length === 0) return false;

        const lastCandle = candles1m[candles1m.length - 1];
        
        // Check pullback depth <= 50% impulse
        if (breakout.direction === TradeDirection.LONG) {
            const pullbackDepth = breakout.price - lastCandle.low;
            if (pullbackDepth > breakout.impulseSize * 0.5) return false;

            // Price returned to range.high or VWAP
            const nearRangeHigh = Math.abs(lastCandle.close - range.high) < range.high * 0.002;
            const nearVWAP = Math.abs(lastCandle.close - vwap) < vwap * 0.002;
            
            return nearRangeHigh || nearVWAP;
        } else {
            const pullbackDepth = lastCandle.high - breakout.price;
            if (pullbackDepth > breakout.impulseSize * 0.5) return false;

            const nearRangeLow = Math.abs(lastCandle.close - range.low) < range.low * 0.002;
            const nearVWAP = Math.abs(lastCandle.close - vwap) < vwap * 0.002;
            
            return nearRangeLow || nearVWAP;
        }
    }

    hasPullbackPattern(candle: Candle, direction: TradeDirection): boolean {
        // Pinbar: shadow > 2x body
        const isPinbar = direction === TradeDirection.LONG
            ? candle.lowerWick > candle.body * 2
            : candle.upperWick > candle.body * 2;

        // Engulfing: simplified (needs previous candle for full check)
        const isEngulfing = candle.bodyPercent > 70;

        return isPinbar || isEngulfing;
    }
}