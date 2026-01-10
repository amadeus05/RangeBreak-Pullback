import { PrismaClient, Candle as PrismaCandle } from '@prisma/client';
import { Candle } from '../../../domain/entities/Candle';
import { injectable } from 'inversify';

@injectable()
export class CandleRepository {
    private prisma: PrismaClient;

    constructor() {
        this.prisma = new PrismaClient();
    }

    async countInRange(symbol: string, timeframe: string, startTime: number, endTime: number): Promise<number> {
        return await this.prisma.candle.count({
            where: {
                symbol,
                timeframe,
                timestamp: {
                    gte: BigInt(startTime),
                    lte: BigInt(endTime)
                }
            }
        });
    }

    // --- РЕАЛИЗУЕМ ЭТОТ МЕТОД (Был заглушкой) ---
    async getLastCandle(symbol: string, timeframe: string): Promise<Candle | null> {
        const prismaCandle = await this.prisma.candle.findFirst({
            where: { symbol, timeframe },
            orderBy: { timestamp: 'desc' } // Берем самую свежую
        });

        return prismaCandle ? this.toDomain(prismaCandle) : null;
    }
    // --------------------------------------------

    async saveCandles(candles: Candle[]): Promise<void> {
        if (candles.length === 0) return;

        const timestamps = candles.map(c => c.timestamp);
        const minTime = Math.min(...timestamps);
        const maxTime = Math.max(...timestamps);

        const existing = await this.prisma.candle.findMany({
            where: {
                symbol: candles[0].symbol,
                timeframe: candles[0].timeframe,
                timestamp: { gte: BigInt(minTime), lte: BigInt(maxTime) }
            },
            select: { timestamp: true }
        });

        const existingSet = new Set(existing.map(e => Number(e.timestamp)));
        const candlesToInsert = candles.filter(c => !existingSet.has(c.timestamp));

        if (candlesToInsert.length === 0) return;

        // Используем transaction для скорости
        const operations = candlesToInsert.map(c => 
            this.prisma.candle.create({
                data: {
                    timestamp: BigInt(c.timestamp),
                    symbol: c.symbol,
                    timeframe: c.timeframe,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume
                }
            })
        );

        try {
            await this.prisma.$transaction(operations);
        } catch (error) {
            // Fallback
            for (const op of operations) try { await op; } catch (e) {}
        }
    }

    async getCandles(symbol: string, timeframe: string, startTime: number, endTime: number): Promise<Candle[]> {
        const prismaCandles = await this.prisma.candle.findMany({
            where: {
                symbol,
                timeframe,
                timestamp: { gte: BigInt(startTime), lte: BigInt(endTime) }
            },
            orderBy: { timestamp: 'asc' }
        });
        return prismaCandles.map(this.toDomain);
    }

    async getDataRange(symbol: string, timeframe: string): Promise<{ min: number, max: number } | null> {
        const aggr = await this.prisma.candle.aggregate({
            where: { symbol, timeframe },
            _min: { timestamp: true },
            _max: { timestamp: true }
        });
        if (!aggr._min.timestamp || !aggr._max.timestamp) return null;
        return { min: Number(aggr._min.timestamp), max: Number(aggr._max.timestamp) };
    }

    async hasData(symbol: string, timeframe: string, timestamp: number): Promise<boolean> {
        const count = await this.prisma.candle.count({ where: { symbol, timeframe, timestamp: BigInt(timestamp) } });
        return count > 0;
    }

    private toDomain(prismaCandle: PrismaCandle): Candle {
        return new Candle(
            Number(prismaCandle.timestamp),
            prismaCandle.open, prismaCandle.high, prismaCandle.low, prismaCandle.close, prismaCandle.volume,
            prismaCandle.symbol, prismaCandle.timeframe
        );
    }
    
    async disconnect(): Promise<void> { await this.prisma.$disconnect(); }
}