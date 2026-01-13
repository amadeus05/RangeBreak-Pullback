/**
 * Strategy Configuration v6.0 - Aggressive Profit Optimization
 * 
 * PHILOSOPHY:
 * - More trades = more opportunities
 * - Adaptive stops based on volatility
 * - Accept wider range of market conditions
 * - Prioritize profit over win rate
 */

export const StrategyConfig = {
    // Timeframes
    structureTimeframe: '5m',
    entryTimeframe: '1m',

    // 🔧 Market regime (MORE LENIENT)
    adx: {
        period: 14,
        min: 15,  // was 18 - accept weaker trends
        max: 50   // was 35 - accept stronger trends too
    },

    volatility: {
        atrPeriod: 14,
        minPercent: 0.08,  // was 0.15 - allow lower volatility
        maxPercent: 2.0    // was 0.6 - allow much higher volatility
    },

    // Range detection (unchanged - not used in momentum)
    range: {
        window: 30,
        minSizeMultiplier: 1.2,
        maxSizeMultiplier: 3.5
    },

    // Breakout (unchanged - not used in momentum)
    breakout: {
        atrMultiplier: 0.1,
        minBodyPercent: 50,  // was 60
        volumePeriod: 20
    },

    // 🔧 Pullback (RELAXED)
    pullback: {
        maxDepthPercent: 80,      // was 50 - allow deeper pullbacks
        maxWaitCandles: 100,      // was 10 - wait longer for structure
        priceTolerancePercent: 0.3 // was 0.2 - more tolerance
    },

    // 🔧 Risk (OPTIMIZED FOR PROFIT)
    risk: {
        riskPercentPerTrade: 1.0,     // unchanged
        maxDailyLossPercent: 5.0,     // was 2 - allow more drawdown
        maxConsecutiveLosses: 5,      // was 2 - allow more streak
        rrRatio: 2.0                  // was 1.5 - target higher R:R
    },

    // 🔧 Limits (INCREASED)
    limits: {
        maxTradesPerDay: 20,   // was 5 - allow more trades
        maxPositionTime: 240   // was 30 - allow longer holds (4 hours)
    },

    // Trend EMAs
    emaFast: 50,
    emaSlow: 200,

    // 🔧 Momentum (MORE AGGRESSIVE)
    momentum: {
        rsiPeriod: 14,
        rsiOverbought: 75,          // was 70 - less restrictive
        rsiOversold: 25,            // was 30 - less restrictive
        volumeMultiplier: 1.0,      // was 1.8 - MUCH more lenient
        priceChangeMin: 0.3         // was 0.5 - accept smaller moves
    },

    // 🔧 NEW: Fibonacci levels for pullback
    fibonacci: {
        min: 0.20,  // Accept 20% pullbacks
        max: 0.80,  // Up to 80% pullbacks
        ideal: 0.50 // Sweet spot at 50%
    },

    // 🔧 NEW: Dynamic stop multipliers
    stops: {
        lowVolatility: 1.5,   // Tight stops in calm markets
        mediumVolatility: 2.0,
        highVolatility: 2.5   // Wider stops in volatile markets
    },

    // 🔧 NEW: Dynamic target multipliers
    targets: {
        lowVolatility: 3.0,   // Conservative targets in calm markets
        mediumVolatility: 4.0,
        highVolatility: 5.0   // Aggressive targets in volatile markets
    },

    // 🔧 RSI (relaxed from momentum detector)
    rsiPeriod: 14,
    rsiOverbought: 75,
    rsiOversold: 25,

    // 🔧 Pullback distance from EMA (relaxed)
    maxPullbackDistance: 0.08  // was 0.05 - allow 8% distance
};

export type StrategyConfigType = typeof StrategyConfig;