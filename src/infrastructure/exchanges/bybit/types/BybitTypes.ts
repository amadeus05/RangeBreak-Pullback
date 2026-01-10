export interface BybitKlineData {
    start: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    turnover: string;
}

export interface BybitKlineResponse {
    retCode: number;
    retMsg: string;
    result: {
        symbol: string;
        category: string;
        list: BybitKlineData[];
    };
    time: number;
}

export interface BybitTickerResponse {
    retCode: number;
    retMsg: string;
    result: {
        list: Array<{
            symbol: string;
            lastPrice: string;
        }>;
    };
}