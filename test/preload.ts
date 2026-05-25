/**
 * Test preload — Global test environment setup.
 *
 * Loaded before every test file via bunfig.toml [test].preload.
 *
 * Chalk disables colors in non-TTY environments (CI, test runners).
 * Force truecolor so ANSI-dependent tests produce consistent output.
 */

import chalk from "chalk";

chalk.level = 3; // truecolor (24-bit) — consistent across all environments

// Keep tests hermetic: production code may auto-discover missing secrets from
// ~/.local/bin/ccc, but tests should only use CCC when a test sets CCC_BIN.
process.env.JERIKO_TEST_DISABLE_DEFAULT_CCC = "1";
