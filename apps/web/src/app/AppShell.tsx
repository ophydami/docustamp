import { Outlet } from "react-router-dom";
import { Sidebar, SidebarDrawer } from "./Sidebar";
import { TopBar } from "./CommandBar";

/** Signed-in layout: sidebar + top command bar + routed content. */
export function AppShell() {
  return (
    <div className="h-full flex bg-ground">
      <Sidebar />
      <SidebarDrawer />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 min-h-0 flex flex-col">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Full-bleed layout for the send flow, editor and signer pages (no sidebar). */
export function BareShell() {
  return (
    <div className="h-full flex flex-col bg-ground">
      <Outlet />
    </div>
  );
}
