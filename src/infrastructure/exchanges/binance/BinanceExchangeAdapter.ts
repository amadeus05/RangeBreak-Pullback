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
        
        const tfMap: Record<string, string> = { 
            '1m': '1m', '5m': '5m', '15m': '15m', 
            '1h': '1h', '4h': '4h', '1d': '1d' 
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

        try {
            const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
            
            if (!response.ok) {
                console.error(`[BINANCE API ERROR] ${response.status} ${response.statusText} for ${symbol}`);
                return [];
            }

            const json = await response.json();

            // ВАЖНО: Проверяем, что это массив. Binance может вернуть объект ошибки.
            if (!Array.isArray(json)) {
                console.error(`[BINANCE API ERROR] Expected array, got object for ${symbol}:`, JSON.stringify(json).slice(0, 100));
                return [];
            }

            return BinanceCandleMapper.toDomainArray(json as BinanceKlineResponse, symbol, timeframe);
        } catch (error) {
            console.error(`[NETWORK ERROR] Failed to fetch candles for ${symbol}:`, error);
            return [];
        }
    }

    async getCurrentPrice(symbol: string): Promise<number> {
        try {
            const endpoint = '/fapi/v1/ticker/price';
            const params = new URLSearchParams({ symbol });
            const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
            const json = await response.json() as BinanceTickerResponse;
            return parseFloat(json.price);
        } catch (e) {
            return 0;
        }
    }

    async placeOrder(): Promise<string> { throw new Error('Not implemented'); }
    async cancelOrder(): Promise<void> { throw new Error('Not implemented'); }
    async getPosition(): Promise<Position | null> { throw new Error('Not implemented'); }
    async closePosition(): Promise<void> { throw new Error('Not implemented'); }
}