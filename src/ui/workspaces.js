/**
 * Built-in workspace presets. Each is a dock layout tuned to one job:
 *
 *   Tracking  — flying a pass right now: map dominant, passes and sky beside it
 *   Planning  — deciding what to work: pass list dominant, map for context
 *   Hardware  — bench and setup work: rotator and radio side by side
 *
 * A preset is just a layout tree (see dock/dock.js), so a user layout saved over
 * one of these is the same shape and restores identically.
 */

export const PRESETS = {
  tracking: {
    name: 'Tracking',
    layout: {
      t: 'split', dir: 'row', sizes: [0.18, 0.52, 0.30],
      kids: [
        { t: 'dock', tabs: ['targets'], active: 'targets' },
        { t: 'dock', tabs: ['viewport'], active: 'viewport' },
        {
          t: 'split', dir: 'col', sizes: [0.58, 0.42],
          kids: [
            { t: 'dock', tabs: ['passes'], active: 'passes' },
            { t: 'dock', tabs: ['sky', 'info'], active: 'sky' },
          ],
        },
      ],
    },
  },

  planning: {
    name: 'Planning',
    layout: {
      t: 'split', dir: 'row', sizes: [0.18, 0.44, 0.38],
      kids: [
        { t: 'dock', tabs: ['targets'], active: 'targets' },
        {
          t: 'split', dir: 'col', sizes: [0.55, 0.45],
          kids: [
            { t: 'dock', tabs: ['viewport'], active: 'viewport' },
            { t: 'dock', tabs: ['info', 'sky'], active: 'info' },
          ],
        },
        { t: 'dock', tabs: ['passes'], active: 'passes' },
      ],
    },
  },

  hardware: {
    name: 'Hardware',
    layout: {
      t: 'split', dir: 'row', sizes: [0.30, 0.40, 0.30],
      kids: [
        { t: 'dock', tabs: ['rotator'], active: 'rotator' },
        {
          t: 'split', dir: 'col', sizes: [0.6, 0.4],
          kids: [
            { t: 'dock', tabs: ['viewport'], active: 'viewport' },
            { t: 'dock', tabs: ['sky'], active: 'sky' },
          ],
        },
        { t: 'dock', tabs: ['radio', 'settings'], active: 'radio' },
      ],
    },
  },
};

export const DEFAULT_PRESET = 'tracking';
