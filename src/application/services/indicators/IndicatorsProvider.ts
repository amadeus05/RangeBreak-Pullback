import { injectable, inject } from 'inversify';
import { IIndicators } from '../../../domain/interfaces/IIndicators';
import { IIndicatorEngine } from '../../../domain/interfaces/IIndicatorEngine';
import { Candle } from '../../../domain/entities/Candle';
import { TYPES } from '../../../config/types';

@injectable()
export class IndicatorsProvider implements IIndicators {
    constructor(
        @inject(TYPES.IIndicatorEngine) private readonly engine: IIndicatorEngine
    ) { }

    rsi(values: number[], period: number): number[] {
        if (values.length <= period) return [];

        const results: number[] = [];
        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const diff = values[i] - values[i - 1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        results.push(100 - (100 / (1 + avgGain / (avgLoss || 1))));

        for (let i = period + 1; i < values.length; i++) {
            const diff = values[i] - values[i - 1];
            const gain = diff >= 0 ? diff : 0;
            const loss = diff < 0 ? -diff : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;

            results.push(100 - (100 / (1 + avgGain / (avgLoss || 1))));
        }

        return results;
    }

    atr(candles: Candle[], period: number): number[] {
        if (candles.length <= period) return [];

        const trs: number[] = [];
        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;
            trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }

        const results: number[] = [];
        let sumTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
        let currentATR = sumTR / period;
        results.push(currentATR);

        for (let i = period; i < trs.length; i++) {
            currentATR = (currentATR * (period - 1) + trs[i]) / period;
            results.push(currentATR);
        }

        return results;
    }

    volumeAverage(candles: Candle[], period: number): number[] {
        if (candles.length < period) return [];

        const results: number[] = [];
        const volumes = candles.map(c => c.volume);

        for (let i = period; i <= volumes.length; i++) {
            const slice = volumes.slice(i - period, i);
            const avg = slice.reduce((a, b) => a + b, 0) / period;
            results.push(avg);
        }

        return results;
    }

    stdDev(values: number[]): number {
        if (values.length === 0) return 0;
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const squareDiffs = values.map(v => Math.pow(v - avg, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(avgSquareDiff);
    }

    ema(values: number[], period: number): number[] {
        if (values.length < period) return [];

        const results: number[] = [];
        const k = 2 / (period + 1);

        let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        results.push(ema);

        for (let i = period; i < values.length; i++) {
            ema = (values[i] * k) + (ema * (1 - k));
            results.push(ema);
        }

        return results;
    }

    detectTrendStructure(candles: Candle[], lookback: number): {
        higherHighs: boolean;
        higherLows: boolean;
        lowerHighs: boolean;
        lowerLows: boolean;
    } {
        if (candles.length < lookback * 2) {
            return { higherHighs: false, higherLows: false, lowerHighs: false, lowerLows: false };
        }

        const recent = candles.slice(-lookback);
        const previous = candles.slice(-lookback * 2, -lookback);

        const recentHigh = Math.max(...recent.map(c => c.high));
        const recentLow = Math.min(...recent.map(c => c.low));

        const previousHigh = Math.max(...previous.map(c => c.high));
        const previousLow = Math.min(...previous.map(c => c.low));

        return {
            higherHighs: recentHigh > previousHigh,
            higherLows: recentLow > previousLow,
            lowerHighs: recentHigh < previousHigh,
            lowerLows: recentLow < previousLow
        };
    }

    crossOver(array1: number[], array2: number[]): boolean {
        if (array1.length < 2 || array2.length < 2) return false;

        const current1 = array1[array1.length - 1];
        const prev1 = array1[array1.length - 2];
        const current2 = array2[array2.length - 1];
        const prev2 = array2[array2.length - 2];

        return prev1 <= prev2 && current1 > current2;
    }

    crossUnder(array1: number[], array2: number[]): boolean {
        if (array1.length < 2 || array2.length < 2) return false;

        const current1 = array1[array1.length - 1];
        const prev1 = array1[array1.length - 2];
        const current2 = array2[array2.length - 1];
        const prev2 = array2[array2.length - 2];

        return prev1 >= prev2 && current1 < current2;
    }
}
