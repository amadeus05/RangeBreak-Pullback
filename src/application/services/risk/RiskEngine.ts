import { injectable } from 'inversify';
import { IRiskEngine } from '../../../domain/interfaces/IRiskEngine';

@injectable()
export class RiskEngine implements IRiskEngine {
    private readonly RISK_PERCENT = 0.01;
    private readonly MAX_DAILY_LOSS = 0.02;
    private readonly MAX_CONSECUTIVE_LOSSES = 2;
    private isGlobalBlock = false;

    calculatePositionSize(balance: number, stopDistance: number): number {
        const riskAmount = balance * this.RISK_PERCENT;
        return riskAmount / stopDistance;
    }

    canTrade(balance: number, dailyLoss: number, consecutiveLosses: number): boolean {
        if (this.isGlobalBlock) return false;

        const dailyLossPercent = dailyLoss / balance;
        
        if (dailyLossPercent >= this.MAX_DAILY_LOSS) {
            this.isGlobalBlock = true;
            console.error('KILL SWITCH: Max daily loss reached');
            return false;
        }

        if (consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
            this.isGlobalBlock = true;
            console.error('KILL SWITCH: Max consecutive losses reached');
            return false;
        }
        
        return true;
    }
}