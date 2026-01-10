export interface IRiskEngine {
    calculatePositionSize(balance: number, stopDistance: number): number;
    canTrade(balance: number, dailyLoss: number, consecutiveLosses: number): boolean;
}