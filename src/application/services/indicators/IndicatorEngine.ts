import { injectable } from 'inversify';
import { IIndicatorEngine } from '../../../domain/interfaces/IIndicatorEngine';
import { Candle } from '../../../domain/entities/Candle';

@injectable()
export class IndicatorEngine implements IIndicatorEngine {
    calculateATR(candles: Candle[], period: number = 14): number {
        if (candles.length < period + 1) return 0;

        const trueRanges: number[] = [];
        
        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].high;
            const low = candles[i].low;
            const prevClose = candles[i - 1].close;
            
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trueRanges.push(tr);
        }

        return this.calculateSMA(trueRanges.slice(-period), period);
    }

    calculateADX(candles: Candle[], period: number = 14): number {
        if (candles.length < period * 2) return 0;

        const smoothing = period;
        let plusDM: number[] = [];
        let minusDM: number[] = [];
        let tr: number[] = [];

        for (let i = 1; i < candles.length; i++) {
            const highDiff = candles[i].high - candles[i - 1].high;
            const lowDiff = candles[i - 1].low - candles[i].low;

            const plusDMValue = highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
            const minusDMValue = lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;

            plusDM.push(plusDMValue);
            minusDM.push(minusDMValue);

            const trValue = Math.max(
                candles[i].high - candles[i].low,
                Math.abs(candles[i].high - candles[i - 1].close),
                Math.abs(candles[i].low - candles[i - 1].close)
            );
            tr.push(trValue);
        }

        const smoothedPlusDM = this.calculateSMA(plusDM.slice(-smoothing), smoothing);
        const smoothedMinusDM = this.calculateSMA(minusDM.slice(-smoothing), smoothing);
        const smoothedTR = this.calculateSMA(tr.slice(-smoothing), smoothing);

        const plusDI = smoothedTR !== 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
        const minusDI = smoothedTR !== 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;

        const dx = plusDI + minusDI !== 0 
            ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 
            : 0;

        return dx;
    }

    calculateVWAP(candles: Candle[]): number {
        if (candles.length === 0) return 0;

        let cumulativeTPV = 0;
        let cumulativeVolume = 0;

        for (const candle of candles) {
            const typicalPrice = (candle.high + candle.low + candle.close) / 3;
            cumulativeTPV += typicalPrice * candle.volume;
            cumulativeVolume += candle.volume;
        }

        return cumulativeVolume !== 0 ? cumulativeTPV / cumulativeVolume : 0;
    }

    calculateSMA(values: number[], period: number): number {
        if (values.length < period) return 0;
        const slice = values.slice(-period);
        return slice.reduce((sum, val) => sum + val, 0) / period;
    }
}