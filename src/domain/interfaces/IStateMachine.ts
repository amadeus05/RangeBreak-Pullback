import { StrategyState } from '../enums/StrategyState';

export interface IStateMachine {
    getCurrentState(): StrategyState;
    transition(newState: StrategyState, reason: string): void;
    canTransition(newState: StrategyState): boolean;
    reset(): void;
}