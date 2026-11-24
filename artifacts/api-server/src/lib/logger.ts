import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";
import {
  safeErrorLog,
  safeLogArguments,
  safeLogFields,
  safeRequestLog,
  safeResponseLog,
} from "./safe-logging";

const isProduction = process.env.NODE_ENV === "production";

export function safeLoggerOptions(): LoggerOptions {
  return {
    level: [
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
      "silent",
    ].includes(process.env.LOG_LEVEL ?? "")
      ? process.env.LOG_LEVEL!
      : "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
    serializers: {
      req: safeRequestLog,
      res: safeResponseLog,
      err: safeErrorLog,
      error: safeErrorLog,
    },
    formatters: { bindings: safeLogFields, log: safeLogFields },
    hooks: {
      logMethod(args, method) {
        method.apply(this, safeLogArguments(args));
      },
    },
  };
}
export function createSafeLogger(destination?: DestinationStream) {
  const options = safeLoggerOptions();
  if (destination) return protectBindings(pino(options, destination));
  return protectBindings(
    pino({
      ...options,
      ...(isProduction
        ? {}
        : {
            transport: {
              target: "pino-pretty",
              options: { colorize: true },
            },
          }),
    }),
  );
}

/** Pino resets a parent's binding formatter for child loggers. Sanitize before
 * child() / setBindings() can serialize, including request-scoped Pino HTTP
 * children. Do not accept a child's message prefix or serializer overrides. */
function protectBindings(instance: Logger): Logger {
  const originalChild = instance.child;
  const originalSetBindings = instance.setBindings;
  instance.child = function (this: Logger, bindings, options) {
    const level = options?.level;
    return originalChild.call(this, safeLogFields(bindings), {
      ...(typeof level === "string" &&
      ["fatal", "error", "warn", "info", "debug", "trace", "silent"].includes(
        level,
      )
        ? { level }
        : {}),
      serializers: {
        req: safeRequestLog,
        res: safeResponseLog,
        err: safeErrorLog,
        error: safeErrorLog,
      },
      formatters: { bindings: safeLogFields, log: safeLogFields },
    });
  } as Logger["child"];
  instance.setBindings = function (this: Logger, bindings) {
    originalSetBindings.call(this, safeLogFields(bindings));
  };
  return instance;
}
export const logger = createSafeLogger();
