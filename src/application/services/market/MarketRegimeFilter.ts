import { injectable, inject } from 'inversify';
import { IMarketRegimeFilter } from '../../../domain/interfaces/IMarketRegimeFilter';
import { IIndicatorEngine } from '../../../domain/interfaces/IIndicatorEngine';
import { Candle } from '../../../domain/entities/Candle';
import { TYPES } from '../../../config/types';

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

        // ИСПРАВЛЕНИЕ 3: Расширяем фильтры
        // Было [18, 35] -> Стало [15, 50] (захватим больше трендов)
        const adxValid = adx >= 15 && adx <= 50;
        
        // Было [0.15%, 0.6%] -> Стало [0.1%, 1.5%] (разрешаем и низкую и высокую волатильность)
        const volValid = volatilityPercent >= 0.1 && volatilityPercent <= 1.5;

        return adxValid && volValid;
    }
}