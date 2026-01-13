/**
 * Momentum Strategy v6.0 - Aggressive Profit Optimization
 * 
 * KEY CHANGES:
 * 1. Relaxed regime filters (accept more market conditions)
 * 2. Extended pullback timeout (50 → 100 bars)
 * 3. Wider Fibonacci range (20%-80% instead of 30%-70%)
 * 4. Lower volume threshold (1.2 → 1.0x)
 * 5. Dynamic R:R based on volatility
 * 6. Early entry on pullback structure (don't wait for perfect bounce)
 */

import { injectable, inject } from 'inversify';
import { Candle } from '../../domain/entities/Candle';
import { TradingSignal } from '../../domain/value-objects/TradingSignal';
import { MarketRegime, TrendDirection, TradeDirection } from '../../domain/enums';
import { PullbackAnalysis } from '../../domain/types/StrategyTypes';
import { TrendAnalyzer } from '../services/detection/TrendAnalyzer';
import { MomentumDetector } from '../services/detection/MomentumDetector';
import { PullbackScanner } from '../services/detection/PullbackScanner';
import { RegimeDetector } from '../services/market/RegimeDetector';
import { TYPES } from '../../config/types';
import { Logger } from '../../shared/logger/Logger';

enum SetupState {
    IDLE,
    WAITING_PULLBACK,
    PULLBACK_CONFIRMED,
    READY_TO_ENTER,
    ENTERED,
    INVALIDATED
}

interface MomentumSetup {
    state: SetupState;
    direction: TrendDirection;
    impulseHigh: number;
    impulseLow: number;
    impulseATR: number;
    impulseVolumeRatio: number;
    barsSinceImpulse: number;
    pullbackHigh?: number;
    pullbackLow?: number;
    pullbackDepth?: number;
    pullback?: PullbackAnalysis;
}

@injectable()
export class MomentumStrategy {
    private setups: Map<string, MomentumSetup> = new Map();
    private logger = Logger.getInstance();
    private analyzeCallCount: Map<string, number> = new Map();

    // 🔧 OPTIMIZATION 1: Relaxed thresholds
    private readonly MIN_VOLUME_RATIO = 1.0;  // was 1.2
    private readonly PULLBACK_TIMEOUT = 100;   // was 50
    private readonly MIN_FIB = 0.20;           // was 0.30
    private readonly MAX_FIB = 0.80;           // was 0.70
    private readonly MIN_TREND_STRENGTH = 0.0; // was implicit filter

    constructor(
        @inject(TYPES.TrendAnalyzer) private readonly trendAnalyzer: TrendAnalyzer,
        @inject(TYPES.MomentumDetector) private readonly momentumDetector: MomentumDetector,
        @inject(TYPES.PullbackScanner) private readonly pullbackScanner: PullbackScanner,
        @inject(TYPES.RegimeDetector) private readonly regimeDetector: RegimeDetector
    ) {
        this.logger.info('StrategyEngine', 'Initialized (Momentum v6.0 - Aggressive)');
    }

    public analyze(symbol: string, candles: Candle[]): TradingSignal | null {
        const callCount = (this.analyzeCallCount.get(symbol) || 0) + 1;
        this.analyzeCallCount.set(symbol, callCount);

        const last = candles[candles.length - 1];
        let setup = this.setups.get(symbol);

        if (!setup) {
            this.resetSetup(symbol);
            setup = this.setups.get(symbol)!;
        }

        // 🔧 OPTIMIZATION 2: More lenient regime filter
        const regime = this.regimeDetector.detect(candles);
        const shouldLog = callCount % 10000 === 0;

        // Accept TRENDING and VOLATILE (was TRENDING only)
        const isValidRegime = regime === MarketRegime.TRENDING ||
            regime === MarketRegime.VOLATILE;

        if (!isValidRegime) {
            if (shouldLog) {
                this.debug(symbol, `⏸️ Invalid regime: ${regime}`);
            }
            if (setup.state !== SetupState.IDLE) {
                return this.invalidate(symbol, `REGIME_INVALID:${regime}`);
            }
            return null;
        }

        const trend = this.trendAnalyzer.analyze(candles, regime);

        switch (setup.state) {
            case SetupState.IDLE: {
                // 🔧 OPTIMIZATION 3: Don't require strong trend
                // Accept weak trends in VOLATILE regime
                const trendOk = regime === MarketRegime.VOLATILE
                    ? trend.direction !== TrendDirection.NEUTRAL
                    : trend.isStrong && trend.direction !== TrendDirection.NEUTRAL;

                if (!trendOk) {
                    if (shouldLog) {
                        this.debug(symbol, `⏸️ Trend weak: ${trend.strength.toFixed(2)}, dir=${trend.direction}`);
                    }
                    return null;
                }

                const momentum = this.momentumDetector.detect(candles);

                if (!momentum.hasSpike) {
                    return null;
                }

                if (momentum.direction !== trend.direction) {
                    return null;
                }

                // 🔧 OPTIMIZATION 4: Lower volume filter
                if (momentum.volumeRatio < this.MIN_VOLUME_RATIO) {
                    if (shouldLog) {
                        this.debug(symbol, `⏸️ Volume too low: ${momentum.volumeRatio.toFixed(2)}`);
                    }
                    return null;
                }

                setup.state = SetupState.WAITING_PULLBACK;
                setup.direction = trend.direction;
                setup.impulseHigh = momentum.high;
                setup.impulseLow = momentum.low;
                setup.impulseATR = momentum.atr;
                setup.impulseVolumeRatio = momentum.volumeRatio;
                setup.barsSinceImpulse = 0;

                this.info(symbol, '🔥 IMPULSE → WAITING_PULLBACK', {
                    dir: setup.direction,
                    vol: setup.impulseVolumeRatio.toFixed(2),
                    regime
                });
                return null;
            }

            case SetupState.WAITING_PULLBACK: {
                setup.barsSinceImpulse++;

                // 🔧 OPTIMIZATION 5: Extended timeout
                if (setup.barsSinceImpulse > this.PULLBACK_TIMEOUT) {
                    this.info(symbol, `⏱️ TIMEOUT after ${this.PULLBACK_TIMEOUT} bars`);
                    return this.invalidate(symbol, 'TIMEOUT');
                }

                // Structural Break Check
                if (setup.direction === TrendDirection.BULLISH && last.low < setup.impulseLow)
                    return this.invalidate(symbol, 'IMPULSE_LOW_BROKEN');
                if (setup.direction === TrendDirection.BEARISH && last.high > setup.impulseHigh)
                    return this.invalidate(symbol, 'IMPULSE_HIGH_BROKEN');

                const pullback = this.pullbackScanner.scan(candles, trend);

                if (!pullback.occurred || !pullback.isValid) {
                    return null;
                }

                // Validation
                if (!this.isValidNumber(pullback.level) ||
                    !this.isValidNumber(pullback.low) ||
                    !this.isValidNumber(pullback.high)) {
                    return this.invalidate(symbol, 'BAD_PULLBACK_VALUES');
                }

                const isLong = setup.direction === TrendDirection.BULLISH;
                const impulseRange = setup.impulseHigh - setup.impulseLow;

                if (!this.isValidNumber(impulseRange) || impulseRange <= 0) {
                    return this.invalidate(symbol, 'BAD_IMPULSE_RANGE');
                }

                const currentPullbackDist = isLong
                    ? setup.impulseHigh - pullback.level
                    : pullback.level - setup.impulseLow;

                const fibLevel = currentPullbackDist / impulseRange;

                if (!this.isValidNumber(fibLevel)) {
                    return this.invalidate(symbol, 'BAD_FIB_LEVEL');
                }

                // 🔧 OPTIMIZATION 6: Wider Fib range
                if (fibLevel < this.MIN_FIB || fibLevel > this.MAX_FIB) {
                    return null;
                }

                setup.pullbackLow = pullback.low;
                setup.pullbackHigh = pullback.high;
                setup.pullbackDepth = pullback.distanceFromEMA / 100;
                setup.pullback = pullback;
                setup.state = SetupState.PULLBACK_CONFIRMED;

                const dateStr = new Date(last.timestamp).toISOString().replace('T', ' ').substring(0, 19);
                const formattedRange = impulseRange.toFixed(2);

                const logMsg =
                    `\n🟢 PULLBACK ${symbol} | ${setup.direction} | Fib ${fibLevel.toFixed(2)}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📊 IMPULSE: ${setup.impulseLow.toFixed(2)} → ${setup.impulseHigh.toFixed(2)} (${formattedRange})\n` +
                    `   ├── ATR: ${setup.impulseATR.toFixed(2)} | 📈 Volume: ×${setup.impulseVolumeRatio.toFixed(2)}\n` +
                    `   └── 🕒 ${setup.barsSinceImpulse} bars ago\n` +
                    `   \n` +
                    `🔄 PULLBACK: ${setup.pullback?.level.toFixed(2)} (${(setup.pullbackDepth! * 100).toFixed(3)}% depth)\n` +
                    `   ├── EMA Dist: ${setup.pullback?.distanceFromEMA.toFixed(3)} | ${setup.pullback?.isValid ? '✅ Valid' : '❌ Invalid'}\n` +
                    `   └── State: ${setup.state}\n` +
                    `   \n` +
                    `⏰ ${dateStr}`;

                this.info(symbol, logMsg);

                // 🔧 OPTIMIZATION 7: Early entry - don't wait for perfect bounce
                // If structure is good, enter immediately
                const earlyEntry = this.shouldEnterEarly(candles, setup, fibLevel);
                if (earlyEntry) {
                    setup.state = SetupState.READY_TO_ENTER;
                    this.info(symbol, '⚡ EARLY ENTRY (structure confirmed)');
                }

                return null;
            }

            case SetupState.PULLBACK_CONFIRMED: {
                if (!setup.pullback) {
                    return this.invalidate(symbol, 'PULLBACK_MISSING');
                }

                const bouncing = this.pullbackScanner.isBouncing(candles, setup.pullback, setup.direction);

                if (!bouncing) {
                    const isLong = setup.direction === TrendDirection.BULLISH;
                    if (isLong && last.close < setup.pullbackLow!) {
                        return this.invalidate(symbol, 'LOWER_LOW');
                    }
                    if (!isLong && last.close > setup.pullbackHigh!) {
                        return this.invalidate(symbol, 'HIGHER_HIGH');
                    }
                    return null;
                }

                setup.state = SetupState.READY_TO_ENTER;
                return null;
            }

            case SetupState.READY_TO_ENTER: {
                const signal = this.generateSignal(symbol, candles, setup);
                setup.state = SetupState.ENTERED;
                this.info(symbol, '🎯 SIGNAL EMITTED', signal);
                return signal;
            }

            case SetupState.ENTERED:
            case SetupState.INVALIDATED:
                this.resetSetup(symbol);
                return null;
        }
    }


    // 🔧 OPTIMIZATION 8: Early entry logic
    private shouldEnterEarly(candles: Candle[], setup: MomentumSetup, fibLevel: number): boolean {
        if (candles.length < 3) return false;

        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const isLong = setup.direction === TrendDirection.BULLISH;

        // Enter early if:
        // 1. Fib is ideal (0.5-0.6)
        // 2. Volume spike on pullback
        // 3. Price structure shows reversal
        const idealFib = fibLevel >= 0.50 && fibLevel <= 0.60;
        const volumeSpike = last.volume > prev.volume * 1.2;

        const priceReversal = isLong
            ? last.close > last.open && last.close > prev.close
            : last.close < last.open && last.close < prev.close;

        return idealFib && (volumeSpike || priceReversal);
    }

    private generateSignal(symbol: string, candles: Candle[], setup: MomentumSetup): TradingSignal {
        const isLong = setup.direction === TrendDirection.BULLISH;
        const last = candles[candles.length - 1];

        const entryBuffer = setup.impulseATR * 0.03; // Smaller buffer for faster entry
        const entry = isLong
            ? setup.pullbackHigh! + entryBuffer
            : setup.pullbackLow! - entryBuffer;

        const impulseRange = setup.impulseHigh - setup.impulseLow;

        // 🔧 OPTIMIZATION 9: Dynamic R:R based on volatility
        // Higher volatility = wider stops, bigger targets
        const atrMultiplier = this.calculateDynamicATRMultiplier(setup.impulseATR, impulseRange);
        const stopATR = setup.impulseATR * atrMultiplier.stop;

        const stopLoss = isLong
            ? setup.pullbackLow! - stopATR
            : setup.pullbackHigh! + stopATR;

        // Target: min(impulseRange * 1.2, 4 ATR)
        const targetDist = Math.max(
            impulseRange * 1.2,
            setup.impulseATR * atrMultiplier.target
        );

        const takeProfit = isLong
            ? entry + targetDist
            : entry - targetDist;

        const confidence = this.calculateConfidence(candles, setup);
        const direction = isLong ? TradeDirection.LONG : TradeDirection.SHORT;

        return TradingSignal.createMarketOrder(
            symbol,
            direction,
            entry,
            stopLoss,
            takeProfit,
            last.timestamp,
            {
                reason: 'momentum_pullback_v6',
                confidence,
                volumeRatio: setup.impulseVolumeRatio,
                fibLevel: setup.pullbackDepth,
                impulseATR: setup.impulseATR,
                rrRatio: targetDist / Math.abs(entry - stopLoss)
            }
        );
    }

    // 🔧 OPTIMIZATION 10: Dynamic ATR multipliers
    private calculateDynamicATRMultiplier(atr: number, impulseRange: number): { stop: number; target: number } {
        // If impulse was large (high volatility), use wider stops/targets
        const volatilityRatio = impulseRange / atr;

        if (volatilityRatio > 5) {
            // High volatility - wider stops, bigger targets
            return { stop: 2.5, target: 5.0 };
        } else if (volatilityRatio > 3) {
            // Medium volatility
            return { stop: 2.0, target: 4.0 };
        } else {
            // Low volatility - tighter stops
            return { stop: 1.5, target: 3.0 };
        }
    }

    private calculateConfidence(candles: Candle[], setup: MomentumSetup): number {
        const last = candles[candles.length - 1];
        const prev = candles.length >= 2 ? candles[candles.length - 2] : last;

        const clamp = (v: number) => Math.max(0, Math.min(v, 1));

        // Volume quality (0.8x..3.0x → 0..1)
        const volumeScore = clamp((setup.impulseVolumeRatio - 0.8) / 2.2);

        // Recency bonus
        const recencyScore = clamp(1 - (setup.barsSinceImpulse / this.PULLBACK_TIMEOUT));

        // Fib score (0.5 is ideal)
        let fibScore = 0.5;
        if (setup.pullback) {
            const impulseRange = setup.impulseHigh - setup.impulseLow;
            if (this.isValidNumber(impulseRange) && impulseRange > 0) {
                const isLong = setup.direction === TrendDirection.BULLISH;
                const dist = isLong
                    ? (setup.impulseHigh - setup.pullback.level)
                    : (setup.pullback.level - setup.impulseLow);
                const fib = dist / impulseRange;
                fibScore = clamp(1 - (Math.abs(fib - 0.5) / 0.3));
            }
        }

        // Pullback distance from EMA
        const pullbackScore = setup.pullback
            ? clamp(1 - (setup.pullback.distanceFromEMA / 2.0))
            : 0.5;

        // Bounce strength
        const isLong = setup.direction === TrendDirection.BULLISH;
        const bounceScore = clamp(
            isLong
                ? (last.close > last.open ? 0.7 : 0.3) + (last.close > prev.close ? 0.3 : 0)
                : (last.close < last.open ? 0.7 : 0.3) + (last.close < prev.close ? 0.3 : 0)
        );

        // Weighted blend (adjusted weights for aggressive strategy)
        return clamp(
            volumeScore * 0.25 +
            recencyScore * 0.15 +
            fibScore * 0.25 +
            pullbackScore * 0.20 +
            bounceScore * 0.15
        );
    }

    private isValidNumber(n: number): boolean {
        return Number.isFinite(n) && !Number.isNaN(n);
    }

    private resetSetup(symbol: string): void {
        this.setups.set(symbol, {
            state: SetupState.IDLE,
            direction: TrendDirection.NEUTRAL,
            impulseHigh: 0,
            impulseLow: 0,
            impulseATR: 0,
            impulseVolumeRatio: 0,
            barsSinceImpulse: 0
        });
    }

    private invalidate(symbol: string, reason: string): null {
        const setup = this.setups.get(symbol);
        this.debug(symbol, `❌ INVALIDATED: ${reason}`, setup);
        if (setup) setup.state = SetupState.INVALIDATED;
        return null;
    }

    private debug(symbol: string, label: string, data?: any) {
        this.logger.debug(`STRATEGY | ${symbol} | ${label}`, data);
    }

    private info(symbol: string, label: string, data?: any) {
        this.logger.info(`STRATEGY | ${symbol} | ${label}`, data);
    }
}