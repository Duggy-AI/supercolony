import { createElement, useCallback } from 'react';
import { render, useApp } from 'ink';
import { DashboardApp } from './app.mjs';
import { DashboardController } from './controller.mjs';
import { createServices } from './services.mjs';

// One process owns terminal input at a time. The coordinator waits for this
// session to exit before starting a native command, then opens the saved view.
process.once('message', async ({ options, restore }) => {
  const controller = new DashboardController(createServices(options));
  options.requestPassword = label => controller.requestPassword(label);
  let feedback;
  if (restore) {
    const { selectedId, extraTargets, notice, error, ...state } = restore;
    feedback = { notice: notice ?? null, error: error ?? null };
    controller.update(state);
    controller.restoreSelectedId = selectedId;
    controller.extraTargets = extraTargets;
  }
  let handoff;
  function Root() {
    const { exit } = useApp();
    const terminal = useCallback(async (args, target) => {
      const { view, filter, query, tab, focus } = controller.getSnapshot();
      handoff = { args, target, restore: {
        view, filter, query, tab, focus,
        selectedId: controller.selected()?.id,
        extraTargets: controller.extraTargets,
      } };
      controller.close();
      exit();
    }, [exit]);
    return createElement(DashboardApp, { controller, ascii: options.ascii, terminal, feedback, welcome: !restore });
  }
  const instance = render(createElement(Root), {
    interactive: true, alternateScreen: true, exitOnCtrlC: false,
    kittyKeyboard: { mode: 'disabled' }, maxFps: 20,
  });
  try {
    await instance.waitUntilExit();
    process.send({ handoff });
  } finally {
    controller.close();
    process.disconnect();
  }
});
