import { MarketRegime } from '../enums/MarketRegime';
import { TrendDirection } from '../enums/TrendDirection';
export { MarketRegime, TrendDirection };

export interface TrendAnalysis {
    direction: TrendDirection;
    strength: number;
    emaFast: number;
    emaSlow: number;
    isStrong: boolean;
}

export interface MomentumSignal {
    hasSpike: boolean;
    rsi: number;
    volumeRatio: number;
    priceChange: number;
    direction: TrendDirection;
    high: number;
    low: number;
    atr: number;
}

export interface PullbackAnalysis {
    occurred: boolean;
    distanceFromEMA: number;
    level: number;
    isValid: boolean;
    low: number;
    high: number;
}
