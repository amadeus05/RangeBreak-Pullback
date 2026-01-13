export const StrategyConfig = {
    // Timeframes
    structureTimeframe: '5m',
    entryTimeframe: '1m',

    // Market regime
    adx: {
        period: 14,
        min: 18,
        max: 35
    },

    volatility: {
        atrPeriod: 14,
        minPercent: 0.15,
        maxPercent: 0.6
    },

    // Range detection
    range: {
        window: 30, // candles
        minSizeMultiplier: 1.2, // * ATR
        maxSizeMultiplier: 3.5  // * ATR
    },

    // Breakout
    breakout: {
        atrMultiplier: 0.1,
        minBodyPercent: 60,
        volumePeriod: 20
    },

    // Pullback
    pullback: {
        maxDepthPercent: 50,
        maxWaitCandles: 10, // 1m candles
        priceTolerancePercent: 0.2
    },

    // Risk
    risk: {
        riskPercentPerTrade: 1,
        maxDailyLossPercent: 2,
        maxConsecutiveLosses: 2,
        rrRatio: 1.5 // min 1.5:1
    },

    // Limits
    limits: {
        maxTradesPerDay: 5,
        maxPositionTime: 30 // minutes
    },

    // New Strategy Components Config
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    maxPullbackDistance: 0.05, // 5%
    emaFast: 50,
    emaSlow: 200,
    momentum: {
        rsiPeriod: 14,
        rsiOverbought: 70,
        rsiOversold: 30,
        volumeMultiplier: 1.8,
        priceChangeMin: 0.5
    }
};

export type StrategyConfigType = typeof StrategyConfig;