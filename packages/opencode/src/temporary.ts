import yargs from "yargs"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { hideBin } from "yargs/helpers"
import path from "path"
const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName(path.basename(process.argv0 || "opencode"))
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware((opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) {
      process.env.HORDECODE_LOG_LEVEL = opts.logLevel
      process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    }
  })
  .command(TuiThreadCommand)
  .parse()
