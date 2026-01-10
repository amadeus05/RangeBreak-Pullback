import { Candle } from '../entities/Candle';
import { MarketRange } from '../value-objects/MarketRange';
import { BreakoutSignal } from '../value-objects/BreakoutSignal';

export interface IBreakoutDetector {
    detectBreakout(
        candle: Candle,
        range: MarketRange,
        atr: number,
        volumeSMA: number
    ): BreakoutSignal | null;
}