import { injectable, inject } from 'inversify';
import { IMarketRegimeFilter } from '../../../domain/interfaces/IMarketRegimeFilter';
import { IIndicatorEngine } from '../../../domain/interfaces/IIndicatorEngine';
import { Candle } from '../../../domain/entities/Candle';
import { TYPES } from '../../../config/inversify.config';

@injectable()
export class MarketRegimeFilter implements IMarketRegimeFilter {
    constructor(
        @inject(TYPES.IIndicatorEngine) private readonly indicatorEngine: IIndicatorEngine
    ) {}

    isMarketValid(candles5m: Candle[]): boolean {
        if (candles5m.length < 30) return false;

        const adx = this.indicatorEngine.calculateADX(candles5m, 14);
        const atr = this.indicatorEngine.calculateATR(candles5m, 14);
        const lastCandle = candles5m[candles5m.length - 1];
        
        const volatilityPercent = (atr / lastCandle.close) * 100;

        // ADX ∈ [18, 35]
        const adxValid = adx >= 18 && adx <= 35;
        
        // ATR/Close ∈ [0.15%, 0.6%]
        const volValid = volatilityPercent >= 0.15 && volatilityPercent <= 0.6;

        return adxValid && volValid;
    }
}