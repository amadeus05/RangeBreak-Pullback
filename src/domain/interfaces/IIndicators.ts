import { Candle } from '../entities/Candle';

export interface IIndicators {
    rsi(values: number[], period: number): number[];
    atr(candles: Candle[], period: number): number[];
    volumeAverage(candles: Candle[], period: number): number[];
    stdDev(values: number[]): number;
    ema(values: number[], period: number): number[];
    detectTrendStructure(candles: Candle[], lookback: number): {
        higherHighs: boolean;
        higherLows: boolean;
        lowerHighs: boolean;
        lowerLows: boolean;
    };
    crossOver(array1: number[], array2: number[]): boolean;
    crossUnder(array1: number[], array2: number[]): boolean;
}
