// Writes its arguments as JSON to $ECHO_ARGS_OUT (for spawn/escaping tests).
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ECHO_ARGS_OUT, JSON.stringify(process.argv.slice(2)));
