import {
  ArrowLeft, Box, CalendarClock, ChevronRight, CircleCheck, CircleDot, CircleExclamationPoint, CircleX, Clipboard,
  Copy, Download, ExternalLink, Eye, EyeOff, Hash, House, Inbox, Info, KeyRound, Link, LoaderCircle, Lock, LockOpen,
  Mail, MapPin, Moon, Package, PackageCheck, PackageOpen, Pencil, Plus, RefreshCw, Search, Settings, ShieldCheck,
  ShieldExclamationPoint, Sparkles, StickyNote, Sun, Timer, Trash, TriangleExclamationPoint, Truck, Upload, X,
  createElement, type IconNode,
} from 'lucide';

/** Tree-shaken icon registry – only the icons listed here end up in the bundle. */
export const icons = {
  arrowLeft: ArrowLeft, box: Box, calendar: CalendarClock, chevronRight: ChevronRight, check: CircleCheck,
  dot: CircleDot, alert: CircleExclamationPoint, error: CircleX, clipboard: Clipboard, copy: Copy, download: Download,
  external: ExternalLink, eye: Eye, eyeOff: EyeOff, hash: Hash, house: House, inbox: Inbox, info: Info, key: KeyRound,
  link: Link, loader: LoaderCircle, lock: Lock, unlock: LockOpen, mail: Mail, pin: MapPin, moon: Moon, package: Package,
  packageCheck: PackageCheck, packageOpen: PackageOpen, pencil: Pencil, plus: Plus, refresh: RefreshCw, search: Search,
  settings: Settings, shield: ShieldCheck, shieldAlert: ShieldExclamationPoint, sparkles: Sparkles, note: StickyNote,
  sun: Sun, timer: Timer, trash: Trash, warning: TriangleExclamationPoint, truck: Truck, upload: Upload, x: X,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof icons;

export function icon(name: IconName, cls = 'size-4', strokeWidth = 1.75): SVGElement {
  const el = createElement(icons[name], {
    class: `shrink-0 ${cls}`,
    'stroke-width': strokeWidth,
    'aria-hidden': 'true',
  });
  return el;
}
