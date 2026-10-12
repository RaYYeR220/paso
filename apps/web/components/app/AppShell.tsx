import type { ReactNode } from "react";
import "@/app/app/app.css";
import { fontVariables } from "./fonts";

export interface AppShellProps {
  /**
   * `screen` keeps the whole flow inside the window on a large display;
   * `page` is an ordinary scrolling document.
   */
  layout?: "screen" | "page";
  children: ReactNode;
}

/** The sheet every Paso screen is printed on: palette, type, paper grain. */
export function AppShell({ layout = "page", children }: AppShellProps) {
  return (
    <div className={`paso-app ${fontVariables}`} data-layout={layout}>
      {children}
      <div className="grain" aria-hidden="true" />
    </div>
  );
}
