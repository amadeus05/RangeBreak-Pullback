export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR'
}

export class Logger {
    private static instance: Logger;
    private logLevel: LogLevel = LogLevel.INFO;

    private constructor() { }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    debug(message: string, data?: any): void {
        if (this.shouldLog(LogLevel.DEBUG)) {
            this.log(LogLevel.DEBUG, message, data);
        }
    }

    info(message: string, data?: any): void {
        if (this.shouldLog(LogLevel.INFO)) {
            this.log(LogLevel.INFO, message, data);
        }
    }

    warn(message: string, data?: any): void {
        if (this.shouldLog(LogLevel.WARN)) {
            this.log(LogLevel.WARN, message, data);
        }
    }

    error(message: string, error?: Error | any): void {
        if (this.shouldLog(LogLevel.ERROR)) {
            this.log(LogLevel.ERROR, message, error);
        }
    }

    private shouldLog(level: LogLevel): boolean {
        const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
        return levels.indexOf(level) >= levels.indexOf(this.logLevel);
    }

    private log(level: LogLevel, message: string, data?: any): void {
        const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const logMessage = `[${timestamp}] [${level}] ${message}`;

        switch (level) {
            case LogLevel.DEBUG:
            case LogLevel.INFO:
                console.log(logMessage, data || '');
                break;
            case LogLevel.WARN:
                console.warn(logMessage, data || '');
                break;
            case LogLevel.ERROR:
                console.error(logMessage, data || '');
                break;
        }
    }
}
