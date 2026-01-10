import { PrismaClient, Candle as PrismaCandle } from '@prisma/client';
import { Candle } from '../../../domain/entities/Candle';
import { injectable } from 'inversify';

@injectable()
export class CandleRepository {
    private prisma: PrismaClient;

    constructor() {
        this.prisma = new PrismaClient();
    }

    async saveCandles(candles: Candle[]): Promise<void> {
        if (candles.length === 0) return;

        const symbol = candles[0].symbol;
        const timeframe = candles[0].timeframe;

        // 1. Находим самую свежую свечу для этого символа в базе
        const lastCandle = await this.prisma.candle.findFirst({
            where: { symbol, timeframe },
            orderBy: { timestamp: 'desc' },
            select: { timestamp: true }
        });

        const lastTimestamp = lastCandle?.timestamp ?? -1n;

        // 2. Оставляем только те свечи, которых еще нет в базе (чей TS больше последнего в базе)
        const dataToInsert = candles
            .map(c => ({
                timestamp: BigInt(c.timestamp),
                symbol: c.symbol,
                timeframe: c.timeframe,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume
            }))
            .filter(c => c.timestamp > lastTimestamp);

        // 3. Вставляем только новые данные
        if (dataToInsert.length > 0) {
            await this.prisma.candle.createMany({
                data: dataToInsert
                // skipDuplicates удаляем, он здесь больше не нужен
            });
        }
    }

    async getCandles(
        symbol: string,
        timeframe: string,
        startTime: number,
        endTime: number
    ): Promise<Candle[]> {
        const prismaCandles = await this.prisma.candle.findMany({
            where: {
                symbol,
                timeframe,
                timestamp: {
                    gte: BigInt(startTime),
                    lte: BigInt(endTime)
                }
            },
            orderBy: {
                timestamp: 'asc'
            }
        });

        return prismaCandles.map(this.toDomain);
    }

    async hasData(symbol: string, timeframe: string, timestamp: number): Promise<boolean> {
        const count = await this.prisma.candle.count({
            where: {
                symbol,
                timeframe,
                timestamp: BigInt(timestamp)
            }
        });

        return count > 0;
    }

    async getLastCandle(symbol: string, timeframe: string): Promise<Candle | null> {
        const prismaCandle = await this.prisma.candle.findFirst({
            where: {
                symbol,
                timeframe
            },
            orderBy: {
                timestamp: 'desc'
            }
        });

        return prismaCandle ? this.toDomain(prismaCandle) : null;
    }

    private toDomain(prismaCandle: PrismaCandle): Candle {
        return new Candle(
            Number(prismaCandle.timestamp),
            prismaCandle.open,
            prismaCandle.high,
            prismaCandle.low,
            prismaCandle.close,
            prismaCandle.volume,
            prismaCandle.symbol,
            prismaCandle.timeframe
        );
    }

    async disconnect(): Promise<void> {
        await this.prisma.$disconnect();
    }
}
