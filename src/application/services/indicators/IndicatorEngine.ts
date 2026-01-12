import { injectable } from 'inversify';
import { IIndicatorEngine } from '../../../domain/interfaces/IIndicatorEngine';
import { Candle } from '../../../domain/entities/Candle';

@injectable()
export class IndicatorEngine implements IIndicatorEngine {
    
     calculateEMA(candles: Candle[], period: number): number {
        if (candles.length < period) return 0;
        
        // Коэффициент сглаживания
        const k = 2 / (period + 1);
        
        // Начинаем с SMA для первых N свечей (правильная инициализация)
        const initialSMA = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
        let ema = initialSMA;
        
        // Проходим по оставшимся свечам, обновляя EMA
        for (let i = period; i < candles.length; i++) {
            ema = (candles[i].close * k) + (ema * (1 - k));
        }
        
        return ema;
    }

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

        // Используем EMA сглаживание (Wilder's smoothing) вместо SMA
        // Для первого ATR используем SMA
        if (trueRanges.length < period) return 0;
        
        const initialATR = this.calculateSMA(trueRanges.slice(0, period), period);
        let atr = initialATR;
        
        // Сглаживаем оставшиеся значения (EMA с коэффициентом 1/period)
        for (let i = period; i < trueRanges.length; i++) {
            atr = (trueRanges[i] + (period - 1) * atr) / period;
        }

        return atr;
    }

    calculateADX(candles: Candle[], period: number = 14): number {
        if (candles.length < period * 2) return 0;
    
        const tr: number[] = [];
        const plusDM: number[] = [];
        const minusDM: number[] = [];
    
        // 1️⃣ TR, +DM, -DM
        for (let i = 1; i < candles.length; i++) {
            const curr = candles[i];
            const prev = candles[i - 1];
    
            const upMove = curr.high - prev.high;
            const downMove = prev.low - curr.low;
    
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    
            tr.push(Math.max(
                curr.high - curr.low,
                Math.abs(curr.high - prev.close),
                Math.abs(curr.low - prev.close)
            ));
        }
    
        // 2️⃣ Initial Wilder smoothing (SMA)
        let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
        const dxValues: number[] = [];
    
        // 3️⃣ Wilder smoothing + DX
        for (let i = period; i < tr.length; i++) {
            atr = (atr * (period - 1) + tr[i]) / period;
            smoothPlusDM = (smoothPlusDM * (period - 1) + plusDM[i]) / period;
            smoothMinusDM = (smoothMinusDM * (period - 1) + minusDM[i]) / period;
    
            const plusDI = (smoothPlusDM / atr) * 100;
            const minusDI = (smoothMinusDM / atr) * 100;
    
            const dx = (plusDI + minusDI === 0)
                ? 0
                : (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
    
            dxValues.push(dx);
        }
    
        // 4️⃣ Initial ADX = SMA(DX)
        let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
        // 5️⃣ Final Wilder ADX
        for (let i = period; i < dxValues.length; i++) {
            adx = (adx * (period - 1) + dxValues[i]) / period;
        }
    
        return adx;
    }
    
    //TODO ⚠️ нужен anchor
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