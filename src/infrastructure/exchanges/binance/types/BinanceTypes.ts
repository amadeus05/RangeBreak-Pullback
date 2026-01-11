export type BinanceKlineData = [
    number,  // 0: Open time
    string,  // 1: Open
    string,  // 2: High
    string,  // 3: Low
    string,  // 4: Close
    string,  // 5: Volume
    number,  // 6: Close time
    string,  // 7: Quote asset volume
    number,  // 8: Number of trades
    string,  // 9: Taker buy base asset volume
    string,  // 10: Taker buy quote asset volume
    string   // 11: Ignore
];

export type BinanceKlineResponse = BinanceKlineData[];

export interface BinanceTickerResponse {
    symbol: string;
    price: string;
    time: number;
}