import { injectable } from 'inversify';
import { IBreakoutDetector } from '../../../domain/interfaces/IBreakoutDetector';
import { Candle } from '../../../domain/entities/Candle';
import { MarketRange } from '../../../domain/value-objects/MarketRange';
import { BreakoutSignal } from '../../../domain/value-objects/BreakoutSignal';
import { TradeDirection } from '../../../domain/enums/TradeDirection';

@injectable()
export class BreakoutDetector implements IBreakoutDetector {
    detectBreakout(
        candle: Candle,
        range: MarketRange,
        atr: number,
        volumeSMA: number
    ): BreakoutSignal | null {
        // LONG: close > range.high + 0.1*ATR
        const longBreakout = candle.close > range.high + 0.1 * atr;
        
        // SHORT: close < range.low - 0.1*ATR
        const shortBreakout = candle.close < range.low - 0.1 * atr;

        // Body >= 60% of candle
        const bodyValid = candle.bodyPercent >= 60;

        // Volume > SMA(volume, 20)
        const volumeValid = candle.volume > volumeSMA;

        if (longBreakout && bodyValid && volumeValid) {
            const impulseSize = candle.close - range.high;
            return new BreakoutSignal(
                TradeDirection.LONG,
                impulseSize,
                candle.high,
                range.high,
                candle.timestamp,
                candle.close
            );
        }

        if (shortBreakout && bodyValid && volumeValid) {
            const impulseSize = range.low - candle.close;
            return new BreakoutSignal(
                TradeDirection.SHORT,
                impulseSize,
                range.low,
                candle.low,
                candle.timestamp,
                candle.close
            );
        }

        return null;
    }
}