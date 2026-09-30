// Bridge to the Mermaid View Edit desktop shell (desktop/preload.cjs).
// In a normal browser `window.mveDesktop` is undefined and every helper is a no-op.

export interface DesktopDocument {
  code: string;
  name: string;
}

export interface MveDesktop {
  // Called once the editor has finished initializing; resolves with the
  // document for this window (undefined for a blank/untitled window).
  ready: () => Promise<DesktopDocument | undefined>;
  // Reports the current editor text so the shell can save it and track edits.
  codeChanged: (code: string) => void;
  // The shell pushes a new document (e.g. after the file changed on disk).
  onLoadDocument: (callback: (doc: DesktopDocument) => void) => void;
}

// Commands the desktop menu runs in the page (invoked with a user gesture so
// full screen is allowed).
export type DesktopCommand = 'toggle-editor' | 'toggle-fullscreen';

declare global {
  interface Window {
    mveDesktop?: MveDesktop;
    mveCommand?: (command: DesktopCommand) => void;
  }
}

export const getDesktop = (): MveDesktop | undefined =>
  typeof window === 'undefined' ? undefined : window.mveDesktop;

export const isDesktop = (): boolean => getDesktop() !== undefined;
