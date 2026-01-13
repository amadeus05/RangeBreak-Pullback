import { injectable, inject } from 'inversify';
import { Candle } from '../../../domain/entities/Candle';
import { MarketRegime } from '../../../domain/enums/MarketRegime';
import { IIndicators } from '../../../domain/interfaces/IIndicators';
import { TYPES } from '../../../config/types';

// 🔧 OPTIMIZATION: More lenient regime classification
const ADX_PERIOD = 14;
const VOLATILITY_PERIOD = 20;
const MIN_CANDLES_REQUIRED = Math.max(ADX_PERIOD * 2, VOLATILITY_PERIOD);

@injectable()
export class RegimeDetector {
    constructor(
        @inject(TYPES.IIndicators) private readonly indicators: IIndicators
    ) { }

    /**
     * Detect current market regime
     * 
     * CHANGES v6.0:
     * - TRENDING: ADX > 15 (was 25) - more lenient
     * - VOLATILE: ADX < 20 AND volatility > 2% (was 3%)
     * - RANGING: Only when extremely choppy (ADX < 15 AND vol < 1%)
     * - Reduced UNKNOWN cases
     */
    public detect(candles: Candle[]): MarketRegime {
        if (candles.length < MIN_CANDLES_REQUIRED) {
            return MarketRegime.UNKNOWN;
        }

        const adx = this.calculateStandardADX(candles, ADX_PERIOD);
        const volatility = this.calculateVolatility(candles, VOLATILITY_PERIOD);

        return this.classifyRegime(adx, volatility);
    }

    private calculateStandardADX(candles: Candle[], period: number): number {
        if (candles.length < period * 2) return 0;

        const trs: number[] = [];
        const plusDMs: number[] = [];
        const minusDMs: number[] = [];

        for (let i = 1; i < candles.length; i++) {
            const curr = candles[i];
            const prev = candles[i - 1];

            const tr = Math.max(
                curr.high - curr.low,
                Math.abs(curr.high - prev.close),
                Math.abs(curr.low - prev.close)
            );
            trs.push(tr);

            const up = curr.high - prev.high;
            const down = prev.low - curr.low;

            let plusDM = 0;
            let minusDM = 0;

            if (up > down && up > 0) {
                plusDM = up;
            }
            if (down > up && down > 0) {
                minusDM = down;
            }

            plusDMs.push(plusDM);
            minusDMs.push(minusDM);
        }

        let smoothTR = 0;
        let smoothPlusDM = 0;
        let smoothMinusDM = 0;

        for (let i = 0; i < period; i++) {
            smoothTR += trs[i];
            smoothPlusDM += plusDMs[i];
            smoothMinusDM += minusDMs[i];
        }

        const dxList: number[] = [];

        const calcDX = (pDM: number, mDM: number, tr: number): number => {
            if (tr === 0) return 0;
            const pDI = (pDM / tr) * 100;
            const mDI = (mDM / tr) * 100;
            const sum = pDI + mDI;
            return sum === 0 ? 0 : (Math.abs(pDI - mDI) / sum) * 100;
        };

        dxList.push(calcDX(smoothPlusDM, smoothMinusDM, smoothTR));

        for (let i = period; i < trs.length; i++) {
            const currentTR = trs[i];
            const currentPlusDM = plusDMs[i];
            const currentMinusDM = minusDMs[i];

            smoothTR = smoothTR - (smoothTR / period) + currentTR;
            smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + currentPlusDM;
            smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + currentMinusDM;

            dxList.push(calcDX(smoothPlusDM, smoothMinusDM, smoothTR));
        }

        if (dxList.length < period) return dxList[dxList.length - 1];

        let adx = dxList.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

        for (let i = period; i < dxList.length; i++) {
            adx = ((adx * (period - 1)) + dxList[i]) / period;
        }

        return adx;
    }

    private calculateVolatility(candles: Candle[], period: number = 20): number {
        if (candles.length < period) return 0;

        const recentCandles = candles.slice(-period);
        const closes = recentCandles.map(c => c.close);

        const returns: number[] = [];

        for (let i = 1; i < closes.length; i++) {
            const returnPct = (closes[i] - closes[i - 1]) / closes[i - 1];
            returns.push(returnPct);
        }

        return this.indicators.stdDev(returns) * 100;
    }

    private classifyRegime(adx: number, volatility: number): MarketRegime {
        // 🔧 OPTIMIZATION: More lenient trending threshold
        if (adx > 15) {
            return MarketRegime.TRENDING;
        }

        // 🔧 OPTIMIZATION: Accept moderate volatility
        if (adx < 20 && volatility > 2.0) {
            return MarketRegime.VOLATILE;
        }

        // 🔧 OPTIMIZATION: Only classify as RANGING when extremely choppy
        if (adx < 15 && volatility <= 1.0) {
            return MarketRegime.RANGING;
        }

        // 🔧 OPTIMIZATION: Default to VOLATILE instead of UNKNOWN
        // This gives strategy a chance to trade in uncertain conditions
        return MarketRegime.VOLATILE;
    }

    public isTrendingRegime(regime: MarketRegime): boolean {
        return regime === MarketRegime.TRENDING;
    }

    public isRangingRegime(regime: MarketRegime): boolean {
        return regime === MarketRegime.RANGING;
    }

    public shouldAvoidTrading(regime: MarketRegime): boolean {
        // 🔧 OPTIMIZATION: Only avoid RANGING (too choppy)
        // Allow VOLATILE and UNKNOWN
        return regime === MarketRegime.RANGING;
    }

    public getRegimeStrength(
        candles: Candle[],
        regime: MarketRegime,
        cachedAdx?: number,
        cachedVolatility?: number
    ): number {
        const adx = cachedAdx ?? this.calculateStandardADX(candles, ADX_PERIOD);

        switch (regime) {
            case MarketRegime.TRENDING:
                return Math.min(adx / 50, 1);

            case MarketRegime.RANGING:
                return Math.min((30 - adx) / 30, 1);

            case MarketRegime.VOLATILE:
                const volatility = cachedVolatility ?? this.calculateVolatility(candles, VOLATILITY_PERIOD);
                return Math.min(volatility / 5, 1);

            default:
                return 0.5; // Give benefit of doubt
        }
    }

    public getRegimeSummary(regime: MarketRegime, candles: Candle[]): string {
        const regimeEmoji = {
            [MarketRegime.TRENDING]: '📈',
            [MarketRegime.RANGING]: '↔️',
            [MarketRegime.VOLATILE]: '⚡',
            [MarketRegime.UNKNOWN]: '❓'
        };

        const adx = this.calculateStandardADX(candles, ADX_PERIOD);
        const strength = this.getRegimeStrength(candles, regime, adx);

        return `${regimeEmoji[regime]} ${regime} | ADX: ${adx.toFixed(1)} | Strength: ${(strength * 100).toFixed(0)}%`;
    }
}