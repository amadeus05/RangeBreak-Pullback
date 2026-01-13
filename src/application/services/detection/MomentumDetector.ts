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
     * 
     * CHANGES v6.0:
     * - More lenient spike detection
     * - Accept moderate volume increases
     * - Earlier detection of momentum shifts
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

    /**
     * 🔧 OPTIMIZATION: More lenient spike detection
     * 
     * OLD LOGIC:
     * - Required volumeRatio >= 1.8x
     * - Required significant price move (0.5%)
     * - Required RSI extremes (>70 or <30)
     * 
     * NEW LOGIC:
     * - Accept volumeRatio >= 1.0x (any above average volume)
     * - Accept smaller price moves (0.3%)
     * - Accept moderate RSI (>60 or <40)
     * - Use OR logic instead of AND for more flexibility
     */
    private hasMomentumSpike(
        rsi: number,
        volumeRatio: number,
        priceChange: number
    ): boolean {
        // 🔧 Relaxed RSI extremes
        const rsiExtreme = rsi > 60 || rsi < 40; // was 70/30

        // 🔧 Any above-average volume counts
        const volumeSpike = volumeRatio >= StrategyConfig.momentum.volumeMultiplier; // 1.0

        // 🔧 Smaller price moves accepted
        const significantMove = Math.abs(priceChange) >= StrategyConfig.momentum.priceChangeMin; // 0.3%

        // 🔧 CRITICAL: Use OR logic for multiple paths to spike
        // Path 1: Strong volume spike (even if price/RSI weak)
        if (volumeRatio >= StrategyConfig.momentum.volumeMultiplier * 1.5) {
            return true;
        }

        // Path 2: Volume + significant price move
        if (volumeSpike && significantMove) {
            return true;
        }

        // Path 3: RSI extreme + volume
        if (rsiExtreme && volumeSpike) {
            return true;
        }

        // Path 4: Large price move alone (panic/euphoria)
        if (Math.abs(priceChange) >= StrategyConfig.momentum.priceChangeMin * 2) {
            return true;
        }

        // Path 5: Moderate conditions but all aligned
        if (volumeRatio > 1.0 && Math.abs(priceChange) > 0.2 && (rsi > 55 || rsi < 45)) {
            return true;
        }

        return false;
    }

    /**
     * 🔧 OPTIMIZATION: More sensitive direction detection
     */
    private determineMomentumDirection(
        rsi: number,
        priceChange: number
    ): TrendDirection {
        // Strong signals
        if (priceChange > StrategyConfig.momentum.priceChangeMin) {
            return TrendDirection.BULLISH;
        }
        if (priceChange < -StrategyConfig.momentum.priceChangeMin) {
            return TrendDirection.BEARISH;
        }

        // 🔧 More sensitive RSI thresholds
        if (rsi > 52) return TrendDirection.BULLISH;  // was 55
        if (rsi < 48) return TrendDirection.BEARISH;  // was 45

        return TrendDirection.NEUTRAL;
    }

    public calculateMomentumScore(signal: MomentumSignal): number {
        const rsiDistance = Math.abs(signal.rsi - 50) / 50;
        const rsiScore = Math.min(rsiDistance, 1);

        // 🔧 Adjusted scoring for lower volume threshold
        const volumeScore = Math.min((signal.volumeRatio - 0.5) / 2.5, 1); // was (x-1)/2

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

        const bullishDiv = priceLow2 < priceLow1 && rsiLow2 > rsiLow1;
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