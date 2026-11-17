/**
 * The terminal tab's title while the UI is open: "Underlay". The terminal's own title is saved on
 * the way in and put back on the way out (xterm's title stack; terminals without it keep
 * "Underlay"). An editor or pager the UI hands the terminal to may set its own, so it is set
 * again when the UI comes back.
 */
export const TITLE = 'Underlay'
export const TITLE_SAVE = '\x1b[22;0t'
export const TITLE_RESTORE = '\x1b[23;0t'
/** OSC 0 sets both the tab and the window title. */
export const titleSeq = (text: string = TITLE) => `\x1b]0;${text}\x07`
