import { injectable } from 'inversify';
import { IExchange } from '../../../domain/interfaces/IExchange';
import { Candle } from '../../../domain/entities/Candle';
import { Position } from '../../../domain/entities/Position';
import { BybitCandleMapper } from './BybitCandleMapper';
import { BybitKlineResponse, BybitTickerResponse } from './types/BybitTypes';

@injectable()
export class BybitExchangeAdapter implements IExchange {
    private readonly baseUrl = 'https://api.bybit.com';

    async getCandles(symbol: string, timeframe: string, limit: number = 200, endTime?: number): Promise<Candle[]> {
        const endpoint = '/v5/market/kline';
        
        // Преобразуем внутренний формат (1m, 5m) в формат Bybit API (1, 5)
        const bybitInterval = this.mapTimeframeToBybit(timeframe);

        const params = new URLSearchParams({
            category: 'linear',
            symbol: symbol,
            interval: bybitInterval,
            limit: limit.toString()
        });

        if (endTime) {
            params.append('end', endTime.toString());
        }

        const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
        const json = await response.json() as BybitKlineResponse;

        if (json.retCode !== 0) {
            throw new Error(`Bybit API error: ${json.retMsg}`);
        }

        // Bybit возвращает данные от Новых к Старым. 
        // Мы разворачиваем массив, чтобы получить хронологический порядок (Старые -> Новые).
        return BybitCandleMapper.toDomainArray(json.result.list, symbol, timeframe).reverse();
    }

    private mapTimeframeToBybit(tf: string): string {
        const map: Record<string, string> = {
            '1m': '1',
            '3m': '3',
            '5m': '5',
            '15m': '15',
            '30m': '30',
            '1h': '60',
            '2h': '120',
            '4h': '240',
            '1d': 'D',
            '1w': 'W'
        };
        return map[tf] || tf;
    }

    async getCurrentPrice(symbol: string): Promise<number> {
        const endpoint = '/v5/market/tickers';
        const params = new URLSearchParams({
            category: 'linear',
            symbol: symbol
        });

        const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
        const json = await response.json() as BybitTickerResponse;

        if (json.retCode !== 0) {
            throw new Error(`Bybit API error: ${json.retMsg}`);
        }

        return parseFloat(json.result.list[0].lastPrice);
    }

    async placeOrder(symbol: string, side: 'Buy' | 'Sell', qty: number, price?: number): Promise<string> {
        throw new Error('Not implemented in Bybit adapter (Read-only for DataFeed)');
    }

    async cancelOrder(orderId: string): Promise<void> {
        throw new Error('Not implemented');
    }

    async getPosition(symbol: string): Promise<Position | null> {
        throw new Error('Not implemented');
    }

    async closePosition(symbol: string): Promise<void> {
        throw new Error('Not implemented');
    }
}