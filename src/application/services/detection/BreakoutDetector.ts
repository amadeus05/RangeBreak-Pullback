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
        // ... (Long/Short breakout logic stays same)
        const longBreakout = candle.close > range.high + 0.1 * atr;
        const shortBreakout = candle.close < range.low - 0.1 * atr;

        // Body >= 60% of candle (можно оставить или снизить до 50)
        const bodyValid = candle.bodyPercent >= 50; 

        // ИСПРАВЛЕНИЕ 4: Объем > 80% от среднего (а не строго выше)
        // Часто объем чуть не дотягивает до SMA, но сигнал валидный
        const volumeValid = candle.volume > (volumeSMA * 0.8); 

        if (longBreakout && bodyValid && volumeValid) {
            // ... return Signal
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
            // ... return Signal
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