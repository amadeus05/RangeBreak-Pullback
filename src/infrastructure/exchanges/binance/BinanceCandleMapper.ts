import { Candle } from '../../../domain/entities/Candle';
import { BinanceKlineData } from './types/BinanceTypes';

export class BinanceCandleMapper {
    static toDomain(data: BinanceKlineData, symbol: string, timeframe: string): Candle {
        // Binance kline structure:
        // [
        //   0: openTime,
        //   1: open,
        //   2: high,
        //   3: low,
        //   4: close,
        //   5: volume,
        //   6: closeTime,
        //   7: quoteAssetVolume,
        //   8: numberOfTrades,
        //   9: takerBuyBaseAssetVolume,
        //   10: takerBuyQuoteAssetVolume,
        //   11: ignore
        // ]

        const volume = parseFloat(data[5]);
        const takerBuyVolume = parseFloat(data[9]);

        return new Candle(
            data[0],                // timestamp (openTime)
            parseFloat(data[1]),    // open
            parseFloat(data[2]),    // high
            parseFloat(data[3]),    // low
            parseFloat(data[4]),    // close
            volume,                 // volume
            symbol,
            timeframe,
            takerBuyVolume          // Pass Taker Buy Volume for Delta calc
        );
    }
    

    static toDomainArray(dataArray: BinanceKlineData[], symbol: string, timeframe: string): Candle[] {
        return dataArray.map(data => this.toDomain(data, symbol, timeframe));
    }
}