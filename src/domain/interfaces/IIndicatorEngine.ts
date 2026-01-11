import { Candle } from '../entities/Candle';

export interface IIndicatorEngine {
    calculateATR(candles: Candle[], period: number): number;
    calculateADX(candles: Candle[], period: number): number;
    calculateVWAP(candles: Candle[]): number;
    calculateSMA(values: number[], period: number): number;
    calculateEMA(candles: Candle[], period: number): number;
    calculateStdDev(values: number[], period: number): number;
    calculateSlope(candles: Candle[], period: number, lookback: number): number;
    calculateZScore(candles: Candle[], period: number): number;
}