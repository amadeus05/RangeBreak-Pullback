import { injectable, inject } from 'inversify';
import { Candle } from '../../../domain/entities/Candle';
import { TrendDirection, MarketRegime } from '../../../domain/enums';
import { TrendAnalysis } from '../../../domain/types/StrategyTypes';
import { IIndicators } from '../../../domain/interfaces/IIndicators';
import { TYPES } from '../../../config/types';
import { StrategyConfig } from '../../../config/strategy.config';

@injectable()
export class TrendAnalyzer {
    constructor(
        @inject(TYPES.IIndicators) private readonly indicators: IIndicators
    ) { }

    /**
     * Analyze trend using EMAs, price structure, and candle quality
     */
    public analyze(candles: Candle[], regime?: MarketRegime): TrendAnalysis {
        const closes = candles.map(c => c.close);

        // Calculate EMAs
        const emaFast = this.indicators.ema(closes, StrategyConfig.emaFast);
        const emaSlow = this.indicators.ema(closes, StrategyConfig.emaSlow);

        if (emaFast.length === 0 || emaSlow.length === 0) {
            return this.getNeutralTrend();
        }

        const currentEmaFast = emaFast[emaFast.length - 1];
        const currentEmaSlow = emaSlow[emaSlow.length - 1];
        const currentPrice = closes[closes.length - 1];

        const direction = this.determineTrendDirection(
            currentPrice,
            currentEmaFast,
            currentEmaSlow
        );

        let strength = this.calculateTrendStrength(
            currentPrice,
            currentEmaFast,
            currentEmaSlow,
            candles,
            StrategyConfig.emaSlow
        );

        if (regime && regime !== MarketRegime.TRENDING) {
            strength *= 0.5;
        }

        const isStrong = strength > 0.3;

        return {
            direction,
            strength,
            emaFast: currentEmaFast,
            emaSlow: currentEmaSlow,
            isStrong
        };
    }

    private determineTrendDirection(
        price: number,
        emaFast: number,
        emaSlow: number
    ): TrendDirection {
        if (price > emaFast && emaFast > emaSlow) {
            return TrendDirection.BULLISH;
        }
        if (price < emaFast && emaFast < emaSlow) {
            return TrendDirection.BEARISH;
        }
        return TrendDirection.NEUTRAL;
    }

    private calculateTrendStrength(
        price: number,
        emaFast: number,
        emaSlow: number,
        candles: Candle[],
        emaSlowPeriod: number
    ): number {
        const emaDiff = Math.abs(emaFast - emaSlow);
        const emaDistance = (emaDiff / emaSlow) * 100;
        const distanceScore = Math.min(emaDistance / 3, 1);

        const structureLookback = Math.max(emaSlowPeriod, 20);
        const trendStructure = this.indicators.detectTrendStructure(candles, structureLookback);
        let structureScore = 0;

        const isBullish = emaFast > emaSlow;

        if (isBullish) {
            if (trendStructure.higherHighs && trendStructure.higherLows) structureScore = 1;
            else if (trendStructure.higherHighs || trendStructure.higherLows) structureScore = 0.5;
        } else {
            if (trendStructure.lowerHighs && trendStructure.lowerLows) structureScore = 1;
            else if (trendStructure.lowerHighs || trendStructure.lowerLows) structureScore = 0.5;
        }

        const recentCandles = candles.slice(-10);
        let strongCandleCount = 0;

        for (const candle of recentCandles) {
            const body = Math.abs(candle.close - candle.open);
            const range = candle.high - candle.low;
            const isQualityCandle = range > 0 && (body / range) > 0.5;

            if (isQualityCandle) {
                const isCandleBullish = candle.close > candle.open;
                if (isCandleBullish === isBullish) {
                    strongCandleCount++;
                }
            }
        }
        const consistencyScore = strongCandleCount / 10;

        let totalScore = (
            distanceScore * 0.4 +
            structureScore * 0.4 +
            consistencyScore * 0.2
        );

        const priceDistancePct = (Math.abs(price - emaFast) / emaFast) * 100;
        if (priceDistancePct > 1.5) {
            const penalty = Math.min((priceDistancePct - 1.5) / 3, 1);
            totalScore *= (1 - penalty);
        }

        return Math.max(0, Math.min(totalScore, 1));
    }

    public isReversal(candles: Candle[], currentTrend: TrendDirection): boolean {
        if (candles.length < 50) return false;
        const closes = candles.map(c => c.close);
        const emaFast = this.indicators.ema(closes, StrategyConfig.emaFast);
        const emaSlow = this.indicators.ema(closes, StrategyConfig.emaSlow);

        if (currentTrend === TrendDirection.BULLISH) {
            return this.indicators.crossUnder(emaFast, emaSlow);
        } else if (currentTrend === TrendDirection.BEARISH) {
            return this.indicators.crossOver(emaFast, emaSlow);
        }
        return false;
    }

    private getNeutralTrend(): TrendAnalysis {
        return {
            direction: TrendDirection.NEUTRAL,
            strength: 0,
            emaFast: 0,
            emaSlow: 0,
            isStrong: false
        };
    }

    public getTrendSummary(trend: TrendAnalysis): string {
        const directionEmoji = {
            [TrendDirection.BULLISH]: '📈',
            [TrendDirection.BEARISH]: '📉',
            [TrendDirection.NEUTRAL]: '➡️'
        };

        let strengthDesc = 'WEAK';
        if (trend.strength > 0.8) strengthDesc = 'VERY STRONG';
        else if (trend.strength > 0.6) strengthDesc = 'STRONG';
        else if (trend.strength > 0.4) strengthDesc = 'MODERATE';

        return `${directionEmoji[trend.direction]} ${trend.direction} (${strengthDesc} ${(trend.strength * 100).toFixed(0)}%)`;
    }
}
