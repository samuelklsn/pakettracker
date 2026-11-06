/**
 * Locks the vault after a period of user inactivity.
 * Activity events are throttled so the timer reset is cheap.
 */
export class AutoLockService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private minutes = 0;
  private lastReset = 0;
  private readonly events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  private readonly onActivity = () => {
    const now = Date.now();
    if (now - this.lastReset > 5_000) this.reset();
  };

  private readonly onLock: () => void;

  constructor(onLock: () => void) {
    this.onLock = onLock;
  }

  start(minutes: number): void {
    this.stop();
    this.minutes = minutes;
    if (minutes <= 0) return;
    for (const e of this.events) window.addEventListener(e, this.onActivity, { passive: true });
    this.reset();
  }

  stop(): void {
    clearTimeout(this.timer);
    for (const e of this.events) window.removeEventListener(e, this.onActivity);
  }

  private reset(): void {
    this.lastReset = Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stop();
      this.onLock();
    }, this.minutes * 60_000);
  }
}
