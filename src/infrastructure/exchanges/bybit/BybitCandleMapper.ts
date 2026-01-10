import { Candle } from '../../../domain/entities/Candle';
import { BybitKlineData } from './types/BybitTypes';

export class BybitCandleMapper {
    static toDomain(data: BybitKlineData, symbol: string, timeframe: string): Candle {
        return new Candle(
            parseInt(data.start),
            parseFloat(data.open),
            parseFloat(data.high),
            parseFloat(data.low),
            parseFloat(data.close),
            parseFloat(data.volume),
            symbol,
            timeframe
        );
    }

    static toDomainArray(dataArray: BybitKlineData[], symbol: string, timeframe: string): Candle[] {
        return dataArray.map(data => this.toDomain(data, symbol, timeframe));
    }
}