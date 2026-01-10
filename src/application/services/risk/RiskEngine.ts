import { injectable } from 'inversify';
import { IRiskEngine } from '../../../domain/interfaces/IRiskEngine';

@injectable()
export class RiskEngine implements IRiskEngine {
    private readonly RISK_PERCENT = 0.01; // 1%
    private readonly MAX_DAILY_LOSS = 0.02; // 2%
    private readonly MAX_CONSECUTIVE_LOSSES = 2;

    calculatePositionSize(balance: number, stopDistance: number): number {
        const riskAmount = balance * this.RISK_PERCENT;
        return riskAmount / stopDistance;
    }

    canTrade(balance: number, dailyLoss: number, consecutiveLosses: number): boolean {
        const dailyLossPercent = dailyLoss / balance;
        
        if (dailyLossPercent >= this.MAX_DAILY_LOSS) return false;
        if (consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) return false;
        
        return true;
    }
}