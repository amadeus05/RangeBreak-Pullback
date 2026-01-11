import { injectable } from 'inversify';
import { IExchange } from '../../../domain/interfaces/IExchange';
import { Candle } from '../../../domain/entities/Candle';
import { Position } from '../../../domain/entities/Position';
import { BinanceCandleMapper } from './BinanceCandleMapper';
import { BinanceKlineResponse, BinanceTickerResponse } from './types/BinanceTypes';

@injectable()
export class BinanceExchangeAdapter implements IExchange {
    private readonly baseUrl = 'https://fapi.binance.com';

    async getCandles(symbol: string, timeframe: string, limit: number = 1000, startTime?: number): Promise<Candle[]> {
        const endpoint = '/fapi/v1/klines';
        
        // Маппинг таймфреймов (Binance использует другой формат)
        const tfMap: Record<string, string> = { 
            '1m': '1m', 
            '5m': '5m', 
            '15m': '15m', 
            '1h': '1h', 
            '4h': '4h', 
            '1d': '1d' 
        };
        const binanceInterval = tfMap[timeframe] || timeframe;

        const params = new URLSearchParams({
            symbol: symbol,
            interval: binanceInterval,
            limit: limit.toString()
        });

        if (startTime) {
            params.append('startTime', startTime.toString());
        }

        const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
        const json = await response.json() as BinanceKlineResponse;

        // Binance уже возвращает [Oldest, ..., Newest], поэтому reverse не нужен
        return BinanceCandleMapper.toDomainArray(json, symbol, timeframe);
    }

    async getCurrentPrice(symbol: string): Promise<number> {
        const endpoint = '/fapi/v1/ticker/price';
        const params = new URLSearchParams({ symbol });
        const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
        const json = await response.json() as BinanceTickerResponse;
        return parseFloat(json.price);
    }

    async placeOrder(): Promise<string> { throw new Error('Not implemented'); }
    async cancelOrder(): Promise<void> { throw new Error('Not implemented'); }
    async getPosition(): Promise<Position | null> { throw new Error('Not implemented'); }
    async closePosition(): Promise<void> { throw new Error('Not implemented'); }
}