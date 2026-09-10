/**
 * Runs before every proof file: an unset or incomplete DAI_SOURCE_TRUTH_DIR
 * must fail the whole run with a clear message, never skip it.
 */
import { resolveSourceTruthDir } from '../helpers/source-truth.js';

resolveSourceTruthDir();
