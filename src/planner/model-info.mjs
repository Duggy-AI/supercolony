export const MODEL_NAME = 'Qwen3.5-0.8B';
export const MODEL_QUANTIZATION = 'Q4_K_M';
export const MODEL_SIZE = 532_517_120;

// Short English lines: each fits a 36-column TUI panel at 40x20.
export function modelDescriptionLines(size = MODEL_SIZE) {
  return [
    'Model: Qwen',
    `Size: ${(size / 1e6).toFixed(1)} MB, downloaded once.`,
    'Use: understands natural language,',
    'picks task settings.',
    'IMD workers execute the tasks.',
    'Kept on this computer for reuse.',
    'No external AI API key needed.',
  ];
}

// Five lines for the compact 40x20 TUI panel.
export function compactModelDescriptionLines(size = MODEL_SIZE) {
  return [
    `Qwen · ${Math.round(size / 1e6)} MB`,
    'Understands your request locally',
    'and chooses task settings.',
    'IMD workers do the work.',
    'Downloaded once; no AI API key.',
  ];
}
