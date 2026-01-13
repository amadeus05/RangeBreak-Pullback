import { injectable } from 'inversify';
import { Candle } from '../../../domain/entities/Candle';
import { TrendDirection } from '../../../domain/enums/TrendDirection';
import { PullbackAnalysis, TrendAnalysis } from '../../../domain/types/StrategyTypes';
import { StrategyConfig } from '../../../config/strategy.config';

@injectable()
export class PullbackScanner {
    /**
     * Scan for pullback based on recent price action
     */
    public scan(candles: Candle[], trend: TrendAnalysis): PullbackAnalysis {
        if (!trend.isStrong || trend.direction === TrendDirection.NEUTRAL) {
            return this.getNoPullback();
        }

        if (candles.length < 10) {
            return this.getNoPullback();
        }

        const recentCandles = candles.slice(-10);
        const isLong = trend.direction === TrendDirection.BULLISH;

        let pullbackLevel = 0;
        let occurred = false;

        if (isLong) {
            const lows = recentCandles.map(c => c.low);
            pullbackLevel = Math.min(...lows);
            const currentPrice = recentCandles[recentCandles.length - 1].close;
            occurred = pullbackLevel < trend.emaFast && currentPrice >= pullbackLevel * 0.998;
        } else {
            const highs = recentCandles.map(c => c.high);
            pullbackLevel = Math.max(...highs);
            const currentPrice = recentCandles[recentCandles.length - 1].close;
            occurred = pullbackLevel > trend.emaFast && currentPrice <= pullbackLevel * 1.002;
        }

        const distancePercent = Math.abs((pullbackLevel - trend.emaFast) / trend.emaFast) * 100;
        const maxDistance = StrategyConfig.maxPullbackDistance * 100;
        const isValid = occurred && distancePercent <= maxDistance;

        return {
            occurred,
            distanceFromEMA: distancePercent,
            level: pullbackLevel,
            isValid,
            low: isLong ? pullbackLevel : trend.emaFast,
            high: isLong ? trend.emaFast : pullbackLevel
        };
    }

    public isBouncing(
        candles: Candle[],
        pullback: PullbackAnalysis,
        trend: TrendDirection
    ): boolean {
        if (!pullback.occurred || candles.length < 3) return false;

        const recentCandles = candles.slice(-3);
        const prevCandle = recentCandles[1];
        const currentCandle = recentCandles[2];

        if (trend === TrendDirection.BULLISH) {
            const isGreen = currentCandle.close > currentCandle.open;
            const higherClose = currentCandle.close > prevCandle.close;
            return isGreen && higherClose;
        } else {
            const isRed = currentCandle.close < currentCandle.open;
            const lowerClose = currentCandle.close < prevCandle.close;
            return isRed && lowerClose;
        }
    }

    public calculatePullbackScore(
        pullback: PullbackAnalysis,
        candles: Candle[],
        trend: TrendDirection
    ): number {
        if (!pullback.occurred || !pullback.isValid) return 0;

        let score = 0;
        const idealDistance = 1.5;
        const distanceDiff = Math.abs(pullback.distanceFromEMA - idealDistance);
        const distanceScore = Math.max(0, 1 - (distanceDiff / 2));
        score += distanceScore * 0.5;

        if (this.isBouncing(candles, pullback, trend)) {
            score += 0.3;
        }

        if (candles.length >= 2) {
            const currentVolume = candles[candles.length - 1].volume;
            const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
            if (currentVolume > avgVolume * 1.1) {
                score += 0.2;
            }
        }

        return Math.min(score, 1);
    }

    public isTooDeep(pullback: PullbackAnalysis, trend: TrendAnalysis): boolean {
        if (!pullback.occurred) return false;
        const maxDepth = StrategyConfig.maxPullbackDistance * 100 * 1.5;
        return pullback.distanceFromEMA > maxDepth;
    }

    private getNoPullback(): PullbackAnalysis {
        return {
            occurred: false,
            distanceFromEMA: 100,
            level: 0,
            isValid: false,
            low: 0,
            high: 0
        };
    }

    public getPullbackSummary(pullback: PullbackAnalysis, trend: TrendDirection): string {
        if (!pullback.occurred) {
            return '⏳ Waiting for pullback...';
        }
        if (!pullback.isValid) {
            return '❌ Pullback invalid (too far from structure)';
        }
        const emoji = trend === TrendDirection.BULLISH ? '🎯' : '🔻';
        return `${emoji} Pullback detected @ ${pullback.level.toFixed(2)} (${pullback.distanceFromEMA.toFixed(2)}% from EMA)`;
    }
}
