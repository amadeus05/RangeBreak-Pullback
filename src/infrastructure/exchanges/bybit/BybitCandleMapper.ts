import { Candle } from '../../../domain/entities/Candle';
import { BybitKlineData } from './types/BybitTypes';

export class BybitCandleMapper {
    static toDomain(data: BybitKlineData, symbol: string, timeframe: string): Candle {
        // data structure: [startTime, open, high, low, close, volume, turnover]
        return new Candle(
            parseInt(data[0]),      // timestamp
            parseFloat(data[1]),    // open
            parseFloat(data[2]),    // high
            parseFloat(data[3]),    // low
            parseFloat(data[4]),    // close
            parseFloat(data[5]),    // volume
            symbol,
            timeframe
        );
    }

    static toDomainArray(dataArray: BybitKlineData[], symbol: string, timeframe: string): Candle[] {
        return dataArray.map(data => this.toDomain(data, symbol, timeframe));
    }
}