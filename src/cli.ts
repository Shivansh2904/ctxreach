#!/usr/bin/env node
import { createCli } from "./program.js";

const cli = createCli({
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
await cli.program.parseAsync();
process.exitCode = cli.status;
