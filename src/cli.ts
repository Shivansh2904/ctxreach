#!/usr/bin/env node
import { createCli } from "./program.js";

const cli = createCli({
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
cli.program.parse();
process.exitCode = cli.status;
