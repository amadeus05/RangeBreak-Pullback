import { injectable, inject } from 'inversify';
import { Candle } from '../../../domain/entities/Candle';
import { MomentumSignal, TrendDirection } from '../../../domain/types/StrategyTypes';
import { IIndicators } from '../../../domain/interfaces/IIndicators';
import { TYPES } from '../../../config/types';
import { StrategyConfig } from '../../../config/strategy.config';

@injectable()
export class MomentumDetector {
    constructor(
        @inject(TYPES.IIndicators) private readonly indicators: IIndicators
    ) { }

    /**
     * Detect momentum signals
     */
    public detect(candles: Candle[]): MomentumSignal {
        const closes = candles.map(c => c.close);
        const rsiValues = this.indicators.rsi(closes, StrategyConfig.momentum.rsiPeriod);

        if (rsiValues.length === 0) {
            return this.getNeutralMomentum();
        }

        const currentRsi = rsiValues[rsiValues.length - 1];
        const volumeRatio = this.calculateVolumeSpike(candles);
        const priceChange = this.calculatePriceVelocity(candles);

        const hasSpike = this.hasMomentumSpike(
            currentRsi,
            volumeRatio,
            priceChange
        );

        const direction = this.determineMomentumDirection(
            currentRsi,
            priceChange
        );

        const recentCandles = candles.slice(-14);
        const high = Math.max(...recentCandles.map(c => c.high));
        const low = Math.min(...recentCandles.map(c => c.low));

        const atrValues = this.indicators.atr(candles, 14);
        const atr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : (high - low);

        return {
            hasSpike,
            rsi: currentRsi,
            volumeRatio,
            priceChange,
            direction,
            high,
            low,
            atr
        };
    }

    private calculateVolumeSpike(candles: Candle[]): number {
        if (candles.length < 20) return 1;
        const currentVolume = candles[candles.length - 1].volume;
        const avgVolumeValues = this.indicators.volumeAverage(candles, 20);
        if (avgVolumeValues.length === 0) return 1;
        const recentAvgVolume = avgVolumeValues[avgVolumeValues.length - 1];
        return recentAvgVolume > 0 ? currentVolume / recentAvgVolume : 1;
    }

    private calculatePriceVelocity(candles: Candle[], lookback: number = 10): number {
        if (candles.length < lookback + 1) return 0;
        const currentPrice = candles[candles.length - 1].close;
        const oldPrice = candles[candles.length - 1 - lookback].close;
        return ((currentPrice - oldPrice) / oldPrice) * 100;
    }

    private hasMomentumSpike(
        rsi: number,
        volumeRatio: number,
        priceChange: number
    ): boolean {
        const rsiExtreme = rsi > StrategyConfig.momentum.rsiOverbought || rsi < StrategyConfig.momentum.rsiOversold;
        const volumeSpike = volumeRatio >= StrategyConfig.momentum.volumeMultiplier;
        const significantMove = Math.abs(priceChange) >= StrategyConfig.momentum.priceChangeMin;

        if (volumeRatio >= StrategyConfig.momentum.volumeMultiplier * 1.2) return true;
        if (volumeSpike && significantMove) return true;
        if (rsiExtreme && volumeSpike) return true;

        return false;
    }

    private determineMomentumDirection(
        rsi: number,
        priceChange: number
    ): TrendDirection {
        if (priceChange > StrategyConfig.momentum.priceChangeMin) return TrendDirection.BULLISH;
        if (priceChange < -StrategyConfig.momentum.priceChangeMin) return TrendDirection.BEARISH;
        if (rsi > 55) return TrendDirection.BULLISH;
        if (rsi < 45) return TrendDirection.BEARISH;
        return TrendDirection.NEUTRAL;
    }

    public calculateMomentumScore(signal: MomentumSignal): number {
        const rsiDistance = Math.abs(signal.rsi - 50) / 50;
        const rsiScore = Math.min(rsiDistance, 1);
        const volumeScore = Math.min((signal.volumeRatio - 1) / 2, 1);
        const priceScore = Math.min(Math.abs(signal.priceChange) / 10, 1);
        return (rsiScore * 0.4 + volumeScore * 0.3 + priceScore * 0.3);
    }

    public isBullish(signal: MomentumSignal): boolean {
        return signal.direction === TrendDirection.BULLISH && signal.hasSpike;
    }

    public isBearish(signal: MomentumSignal): boolean {
        return signal.direction === TrendDirection.BEARISH && signal.hasSpike;
    }

    private getNeutralMomentum(): MomentumSignal {
        return {
            hasSpike: false,
            rsi: 50,
            volumeRatio: 1,
            priceChange: 0,
            direction: TrendDirection.NEUTRAL,
            high: 0,
            low: 0,
            atr: 0
        };
    }

    /**
     * Check for momentum divergence
     */
    public detectDivergence(candles: Candle[]): {
        bullishDiv: boolean;
        bearishDiv: boolean;
    } {
        if (candles.length < 50) {
            return { bullishDiv: false, bearishDiv: false };
        }

        const closes = candles.map(c => c.close);
        const rsiValues = this.indicators.rsi(closes, 14);

        if (rsiValues.length < 30) {
            return { bullishDiv: false, bearishDiv: false };
        }

        const recentPrices = closes.slice(-20);
        const recentRSI = rsiValues.slice(-20);

        const priceLow1 = Math.min(...recentPrices.slice(0, 10));
        const priceLow2 = Math.min(...recentPrices.slice(10));
        const priceHigh1 = Math.max(...recentPrices.slice(0, 10));
        const priceHigh2 = Math.max(...recentPrices.slice(10));

        const rsiLow1 = Math.min(...recentRSI.slice(0, 10));
        const rsiLow2 = Math.min(...recentRSI.slice(10));
        const rsiHigh1 = Math.max(...recentRSI.slice(0, 10));
        const rsiHigh2 = Math.max(...recentRSI.slice(10));

        // Bullish divergence: price makes lower low, RSI makes higher low
        const bullishDiv = priceLow2 < priceLow1 && rsiLow2 > rsiLow1;

        // Bearish divergence: price makes higher high, RSI makes lower high
        const bearishDiv = priceHigh2 > priceHigh1 && rsiHigh2 < rsiHigh1;

        return { bullishDiv, bearishDiv };
    }

    /**
     * Get momentum summary
     */
    public getMomentumSummary(signal: MomentumSignal): string {
        const directionEmoji = {
            [TrendDirection.BULLISH]: '🚀',
            [TrendDirection.BEARISH]: '💥',
            [TrendDirection.NEUTRAL]: '➡️'
        };

        const spikeStatus = signal.hasSpike ? 'SPIKE' : 'NORMAL';
        const score = this.calculateMomentumScore(signal);

        return `${directionEmoji[signal.direction]} ${spikeStatus} | RSI: ${signal.rsi.toFixed(1)} | Vol: ${signal.volumeRatio.toFixed(2)}x | Score: ${(score * 100).toFixed(0)}%`;
    }
}
