import config from 'config';
import { createLogger, config as wconfig, transports, format } from 'winston';
import ecsFormat from '@elastic/ecs-winston-format'

format['ecs'] = () => ecsFormat({ convertReqRes: true });
const { combine } = format;

const logger = createLogger({
  levels: wconfig.npm.levels,
  transports: [
    ...(config.has("logging.transport.console") ?
          config.get("logging.transport.console").map(cfg => new transports.Console(cfg))
        : []
    ),
    ...(config.has("logging.transport.file") ?
          config.get("logging.transport.file").map(cfg => new transports.File(cfg))
        : []
    ),
  ],
  exitOnError: config.get("logging.exitOnError"),
  format: combine(
    ...config.get("logging.formatters").map(key => format[key]())
  )
})
export { logger };