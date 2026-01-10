import { Candle } from '../entities/Candle';

export interface IIndicatorEngine {
    calculateATR(candles: Candle[], period: number): number;
    calculateADX(candles: Candle[], period: number): number;
    calculateVWAP(candles: Candle[]): number;
    calculateSMA(values: number[], period: number): number;
}