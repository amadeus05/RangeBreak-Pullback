import { injectable } from 'inversify';
import { IExchange } from '../../../domain/interfaces/IExchange';
import { Candle } from '../../../domain/entities/Candle';
import { Position } from '../../../domain/entities/Position';
import { BybitCandleMapper } from './BybitCandleMapper';
import { BybitKlineResponse, BybitTickerResponse } from './types/BybitTypes';

@injectable()
export class BybitExchangeAdapter implements IExchange {
    private readonly baseUrl = 'https://api.bybit.com';

    async getCandles(symbol: string, timeframe: string, limit: number = 200): Promise<Candle[]> {
        const endpoint = '/v5/market/kline';
        const params = new URLSearchParams({
            category: 'linear',
            symbol: symbol,
            interval: timeframe,
            limit: limit.toString()
        });

        const response = await fetch(`${this.baseUrl}${endpoint}?${params}`);
        const json = await response.json() as BybitKlineResponse;

        if (json.retCode !== 0) {
            throw new Error(`Bybit API error: ${json.retMsg}`);
        }

        return BybitCandleMapper.toDomainArray(json.result.list, symbol, timeframe).reverse();
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
        throw new Error('Not implemented - use PaperTradingExchange for backtest');
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