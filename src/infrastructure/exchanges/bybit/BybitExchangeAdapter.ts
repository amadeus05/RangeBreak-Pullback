import { injectable } from 'inversify';
import { IExchange } from '../../../domain/interfaces/IExchange';
import { Candle } from '../../../domain/entities/Candle';
import { Position } from '../../../domain/entities/Position';
import { BybitCandleMapper } from './BybitCandleMapper';
import { BybitKlineResponse, BybitTickerResponse } from './types/BybitTypes';

@injectable()
export class BybitExchangeAdapter implements IExchange {
    private readonly baseUrl = 'https://api.bybit.com';

    async getCandles(symbol: string, timeframe: string, limit: number = 1000, startTime?: number): Promise<Candle[]> {
        const endpoint = '/v5/market/kline';
        
        // Маппинг таймфреймов
        const tfMap: Record<string, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
        const bybitInterval = tfMap[timeframe] || timeframe;

        const params = new URLSearchParams({
            category: 'linear',
            symbol: symbol,
            interval: bybitInterval,
            limit: limit.toString()
        });

        // Реализуем логику startTime как в Binance
        if (startTime) {
            params.append('start', startTime.toString());
        }

        const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
        const json = await response.json() as BybitKlineResponse;

        if (json.retCode !== 0) {
            throw new Error(`Bybit API error: ${json.retMsg}`);
        }

        // Bybit возвращает [Newest, ..., Oldest].
        // Твоя логика (curr = last + 1) требует [Oldest, ..., Newest].
        // Поэтому делаем reverse().
        return BybitCandleMapper.toDomainArray(json.result.list, symbol, timeframe).reverse();
    }

    async getCurrentPrice(symbol: string): Promise<number> {
        const endpoint = '/v5/market/tickers';
        const params = new URLSearchParams({ category: 'linear', symbol });
        const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
        const json = await response.json() as BybitTickerResponse;
        return parseFloat(json.result.list[0].lastPrice);
    }

    async placeOrder(): Promise<string> { throw new Error('Not implemented'); }
    async cancelOrder(): Promise<void> { throw new Error('Not implemented'); }
    async getPosition(): Promise<Position | null> { throw new Error('Not implemented'); }
    async closePosition(): Promise<void> { throw new Error('Not implemented'); }
}