import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { ok } from "../../../shared/output.js";
import { buildLatestDiagnosis, formatDiagnosisText } from "../../../daemon/diagnostics/session.js";

export const command: CommandHandler = {
  name: "diagnose",
  description: "Diagnose the latest Jeriko agent session",
  async run(args: string[]) {
    const parsed = parseArgs(args);
    if (flagBool(parsed, "help")) {
      console.log("Usage: jeriko diagnose latest [--session <id-or-slug>] [--cwd <path>] [--format json|text]");
      console.log("\nPrints latest session, last prompt, latest tool call/result, repeats, changed files, and likely stuck reason.");
      process.exit(0);
    }

    const target = parsed.positional[0] ?? "latest";
    if (target !== "latest") {
      throw new Error(`Unknown diagnose target: ${target}. Expected: latest`);
    }

    const sessionId = flagStr(parsed, "session", "") || undefined;
    const cwd = flagStr(parsed, "cwd", process.cwd());
    const diagnosis = buildLatestDiagnosis({ sessionId, cwd });

    if (flagBool(parsed, "plain")) {
      console.log(formatDiagnosisText(diagnosis));
      process.exit(0);
    }

    ok(diagnosis);
  },
};
