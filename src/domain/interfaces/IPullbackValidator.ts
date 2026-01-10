import { Candle } from '../entities/Candle';
import { BreakoutSignal } from '../value-objects/BreakoutSignal';
import { MarketRange } from '../value-objects/MarketRange';
import { TradeDirection } from '../enums/TradeDirection';

export interface IPullbackValidator {
    isPullbackValid(
        candles1m: Candle[],
        breakout: BreakoutSignal,
        range: MarketRange,
        vwap: number
    ): boolean;
    hasPullbackPattern(candle: Candle, direction: TradeDirection): boolean;
}