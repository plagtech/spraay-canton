import winston from "winston";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...rest }) => {
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
      return `${timestamp} [spraay-canton] ${level}: ${message}${extra}`;
    })
  ),
  transports: [new winston.transports.Console()],
});
