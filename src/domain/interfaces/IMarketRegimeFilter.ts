import { Candle } from '../entities/Candle';

export interface IMarketRegimeFilter {
    isMarketValid(candles5m: Candle[]): boolean;
}