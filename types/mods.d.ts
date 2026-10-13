// Minimal type declarations for the globals Decky Loader provides inside Steam.
declare module "@decky/ui" { export const ButtonItem: any, DialogButton: any, Field: any, Focusable: any, GamepadButton: any, Navigation: any, PanelSection: any, PanelSectionRow: any, Router: any, staticClasses: any, TextField: any; }
declare module "@decky/api" { export const routerHook: any; export function definePlugin(f: (...a: any[]) => any): any; export function callable<A extends any[], R>(n: string): (...a: A) => Promise<R>; }
declare module "react" {
  export function useState<T>(v: T | (() => T)): [T, (x: T | ((p: T) => T)) => void];
  export function useEffect(f: () => any, d?: any[]): void;
  export function useRef<T>(v: T): { current: T };
}
declare module "react-icons/fa" { export const FaHeart: any, FaStar: any, FaTimes: any, FaUndo: any; }
