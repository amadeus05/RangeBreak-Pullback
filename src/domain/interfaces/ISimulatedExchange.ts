import { IExchange } from './IExchange';

export interface ISimulatedExchange extends IExchange {
    setBalance(balance: number): void;
}